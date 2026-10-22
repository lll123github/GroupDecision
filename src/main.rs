use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{sse::{Event, KeepAlive, Sse}, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use argon2::{password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString}, Argon2};
use chrono::{DateTime, Utc};
use rand_core::OsRng;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    net::SocketAddr,
    path::PathBuf,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::Duration,
};
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};
use uuid::Uuid;

type ApiResult<T> = Result<T, ApiError>;
#[derive(Debug)]
struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        eprintln!("database error: {e}");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "数据库操作失败，请稍后重试".into())
    }
}
fn bad(s: &str) -> ApiError { ApiError(StatusCode::BAD_REQUEST, s.into()) }
fn denied() -> ApiError { ApiError(StatusCode::FORBIDDEN, "你没有执行此操作的权限".into()) }
fn missing() -> ApiError { ApiError(StatusCode::NOT_FOUND, "内容不存在或已不可用".into()) }
fn now() -> i64 { Utc::now().timestamp() }
fn uid() -> String { Uuid::new_v4().simple().to_string() }
fn digest(s: &str) -> String { format!("{:x}", Sha256::digest(s.as_bytes())) }
fn string(v: &Value, key: &str) -> String { v[key].as_str().unwrap_or("").trim().to_owned() }
fn text(v: &Value, key: &str, min: usize, max: usize) -> ApiResult<String> {
    let s = string(v, key);
    if s.chars().count() < min || s.chars().count() > max {
        let label=match key {"title"=>"标题","description"=>"描述","name"=>"名称","email"=>"邮箱","password"=>"密码","body"=>"讨论内容","details"=>"选项详情","merged_title"=>"合并后的名称","merged_details"=>"合并说明",_=>"输入内容"};
        return Err(bad(&format!("{label}的长度需要在 {min} 到 {max} 字符之间")));
    }
    Ok(s)
}
fn bounded(v: &Value, key: &str, default: i64, min: i64, max: i64) -> ApiResult<i64> {
    let n = match v.get(key) { Some(x) => x.as_i64().ok_or_else(|| bad("数字格式不正确"))?, None => default };
    if n < min || n > max { return Err(bad("数字超出允许范围")); }
    Ok(n)
}
fn ids(v: &Value, key: &str, min: usize) -> ApiResult<Vec<String>> {
    let raw = v[key].as_array().ok_or_else(|| bad("请选择需要操作的内容"))?;
    if raw.len() < min || raw.len() > 100 { return Err(bad("选择数量不正确")); }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for x in raw {
        let s = x.as_str().ok_or_else(|| bad("编号格式不正确"))?.to_string();
        if s.len() > 80 || !seen.insert(s.clone()) { return Err(bad("选择中存在重复或无效内容")); }
        out.push(s);
    }
    Ok(out)
}
fn parse_json(s: String) -> Value { serde_json::from_str(&s).unwrap_or(Value::Null) }
fn collect(c: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql], mapper: fn(&Row<'_>) -> rusqlite::Result<Value>) -> ApiResult<Vec<Value>> {
    let mut q = c.prepare(sql)?;
    let rows = q.query_map(args, mapper)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Clone)]
struct App {
    db: Arc<Mutex<Connection>>,
    events: broadcast::Sender<String>,
    attempts: Arc<Mutex<HashMap<String, (u32, i64)>>>,
    secure_cookie: bool,
    shutdown: Arc<AtomicBool>,
}
impl App {
    fn publish(&self) { let _ = self.events.send("refresh".into()); }
}
fn default_settings() -> Value {
    json!({
        "tag_order": ["产品", "研发", "日常"],
        "allow_add_options": true,
        "allow_merge": true,
        "allow_rename_subdecision": true,
        "reminder_permission": "both",
        "remind_minutes": 30,
        "reminder_audience": "stale",
        "sub_remind_minutes": 15,
        "sub_notify_on_create": true,
        "auto_folder_threshold": 3
    })
}
fn validate_settings(v: &Value, base: Value) -> ApiResult<Value> {
    let mut out = base;
    for k in ["allow_add_options", "allow_merge", "allow_rename_subdecision", "sub_notify_on_create"] {
        if let Some(x) = v.get(k) {
            if !x.is_boolean() { return Err(bad("设置格式不正确")); }
            out[k] = x.clone();
        }
    }
    for (k, min, max) in [("remind_minutes", 1, 43200), ("sub_remind_minutes", 1, 43200), ("auto_folder_threshold", 1, 50)] {
        if v.get(k).is_some() { out[k] = json!(bounded(v, k, min, min, max)?); }
    }
    for (k, allowed) in [("reminder_permission", vec!["organizer", "members", "both"]), ("reminder_audience", vec!["stale", "unvoted", "all"])] {
        if let Some(x) = v.get(k) {
            let s = x.as_str().ok_or_else(|| bad("设置格式不正确"))?;
            if !allowed.contains(&s) { return Err(bad("设置值不正确")); }
            out[k] = x.clone();
        }
    }
    if let Some(tags) = v.get("tag_order") {
        let arr = tags.as_array().ok_or_else(|| bad("标签格式不正确"))?;
        if arr.len() > 30 { return Err(bad("最多可设置 30 个标签")); }
        let mut seen = HashSet::new();
        let mut clean = Vec::new();
        for tag in arr {
            let tag = tag.as_str().unwrap_or("").trim();
            if tag.is_empty() || tag.chars().count() > 20 { return Err(bad("标签需为 1 到 20 字符")); }
            if seen.insert(tag.to_string()) { clean.push(tag); }
        }
        out["tag_order"] = json!(clean);
    }
    Ok(out)
}
fn csrf(h: &HeaderMap) -> ApiResult<()> {
    if h.get("sec-fetch-site").and_then(|x| x.to_str().ok()) == Some("cross-site") { return Err(denied()); }
    if let Some(origin) = h.get(header::ORIGIN).and_then(|x| x.to_str().ok()) {
        let authority = origin.split_once("://").map(|x| x.1.trim_end_matches('/')).unwrap_or("");
        let host = h.get(header::HOST).and_then(|x| x.to_str().ok()).unwrap_or("");
        if authority != host { return Err(denied()); }
    }
    Ok(())
}
fn auth(c: &Connection, h: &HeaderMap) -> ApiResult<String> {
    let cookie = h.get(header::COOKIE).and_then(|h| h.to_str().ok()).unwrap_or("");
    let token = cookie.split(';').find_map(|p| p.trim().strip_prefix("dtrp_session=")).unwrap_or("");
    if token.len() != 64 { return Err(ApiError(StatusCode::UNAUTHORIZED, "请先登录".into())); }
    c.query_row("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?", params![digest(token), now()], |r| r.get(0))
        .optional()?.ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "登录已过期，请重新登录".into()))
}
fn role(c: &Connection, group: &str, user: &str) -> ApiResult<String> {
    c.query_row("SELECT role FROM memberships WHERE group_id=? AND user_id=?", params![group,user], |r| r.get(0))
        .optional()?.ok_or_else(denied)
}
fn leader(c: &Connection, group: &str, user: &str) -> ApiResult<()> {
    if role(c,group,user)? != "organizer" { return Err(denied()); }
    Ok(())
}
fn group_settings(c: &Connection, group: &str) -> ApiResult<Value> {
    let s: String = c.query_row("SELECT settings FROM groups WHERE id=?", [group], |r| r.get(0))?;
    Ok(parse_json(s))
}
fn decision_row(r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_,String>(0)?, "group_id":r.get::<_,String>(1)?,
        "parent_id":r.get::<_,Option<String>>(2)?, "kind":r.get::<_,String>(3)?,
        "title":r.get::<_,String>(4)?, "description":r.get::<_,String>(5)?,
        "deadline":r.get::<_,i64>(6)?, "importance":r.get::<_,i64>(7)?,
        "tags":parse_json(r.get(8)?), "folder_id":r.get::<_,Option<String>>(9)?,
        "creator_id":r.get::<_,String>(10)?, "status":r.get::<_,String>(11)?,
        "version":r.get::<_,i64>(12)?, "settings":parse_json(r.get(13)?),
        "merge_payload":parse_json(r.get(14)?), "created_at":r.get::<_,i64>(15)?,
        "outcome":r.get::<_,Option<String>>(16)?, "multi_select":r.get::<_,bool>(17)?
    }))
}
const DECISION_SELECT: &str = "SELECT id,group_id,parent_id,kind,title,description,deadline,importance,tags,folder_id,creator_id,status,version,settings,merge_payload,created_at,outcome,multi_select FROM decisions";
fn decision(c: &Connection, id: &str, user: &str) -> ApiResult<Value> {
    let d = c.query_row(&format!("{DECISION_SELECT} WHERE id=?"), [id], decision_row).optional()?.ok_or_else(missing)?;
    role(c, d["group_id"].as_str().unwrap(), user)?;
    Ok(d)
}
fn ensure_open(d: &Value) -> ApiResult<()> {
    if d["status"] != "open" || d["deadline"].as_i64().unwrap_or(0) <= now() { return Err(bad("决策已结束，不能再修改选项或投票")); }
    Ok(())
}
fn summarize(c: &Connection, mut d: Value, user: &str) -> ApiResult<Value> {
    let id = d["id"].as_str().unwrap().to_owned();
    let options = collect(c, "SELECT id,title,details,creator_id,created_at,archived,source_ids FROM options WHERE decision_id=? ORDER BY created_at,id", &[&id], option_row)?;
    let active: HashSet<String> = options.iter().filter(|x| x["archived"] == false).map(|x| x["id"].as_str().unwrap().to_string()).collect();
    let ballots = collect(c, "SELECT user_id,selected_ids,version,updated_at FROM ballots WHERE decision_id=?", &[&id], ballot_row)?;
    let mut counts: HashMap<String,usize> = HashMap::new();
    for b in &ballots {
        for option in b["selected_ids"].as_array().unwrap() {
            if let Some(s) = option.as_str().filter(|s| active.contains(*s)) { *counts.entry(s.to_string()).or_default() += 1; }
        }
    }
    d["option_count"] = json!(active.len());
    d["vote_count"] = json!(ballots.iter().filter(|b| b["selected_ids"].as_array().unwrap().iter().any(|x| x.as_str().is_some_and(|s|active.contains(s)))).count());
    d["comment_count"] = json!(c.query_row("SELECT count(*) FROM comments WHERE decision_id=?", [&id], |r| r.get::<_,i64>(0))?);
    d["my_vote"] = ballots.iter().find(|b| b["user_id"] == user).cloned().unwrap_or(Value::Null);
    d["needs_review"] = json!(!d["my_vote"].is_null() && d["my_vote"]["version"].as_i64().unwrap_or(0) < d["version"].as_i64().unwrap());
    d["option_counts"] = json!(counts);
    Ok(d)
}
fn option_row(r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({"id":r.get::<_,String>(0)?, "title":r.get::<_,String>(1)?, "details":r.get::<_,String>(2)?,
        "creator_id":r.get::<_,String>(3)?, "created_at":r.get::<_,i64>(4)?, "archived":r.get::<_,bool>(5)?, "source_ids":parse_json(r.get(6)?)}))
}
fn ballot_row(r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({"user_id":r.get::<_,String>(0)?, "selected_ids":parse_json(r.get(1)?), "version":r.get::<_,i64>(2)?, "updated_at":r.get::<_,i64>(3)?}))
}
fn notify(c: &Connection, group: &str, decision: Option<&str>, user: &str, kind: &str, message: &str, key: &str) -> ApiResult<()> {
    c.execute("INSERT OR IGNORE INTO notifications(id,group_id,decision_id,user_id,kind,message,dedupe_key,created_at) VALUES(?,?,?,?,?,?,?,?)",params![uid(),group,decision,user,kind,message,key,now()])?;
    Ok(())
}
fn members(c: &Connection, group: &str) -> ApiResult<Vec<String>> {
    let mut q = c.prepare("SELECT user_id FROM memberships WHERE group_id=?")?;
    let rows = q.query_map([group], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<_>,_>>()?)
}
fn audit(c: &Connection, group: &str, user: &str, action: &str, payload: &Value) -> ApiResult<()> {
    c.execute("INSERT INTO audit_log(id,group_id,user_id,action,payload,created_at) VALUES(?,?,?,?,?,?)",params![uid(),group,user,action,payload.to_string(),now()])?;
    Ok(())
}
fn auth_limit(app: &App, key: String) -> ApiResult<()> {
    let mut map = app.attempts.lock().unwrap();
    let t=now();
    map.retain(|_,v| t-v.1<300);
    let entry = map.entry(key).or_insert((0,t));
    if t-entry.1>=60 { *entry=(0,t); }
    entry.0+=1;
    if entry.0>15 { return Err(ApiError(StatusCode::TOO_MANY_REQUESTS,"登录尝试过多，请一分钟后再试".into())); }
    Ok(())
}
fn cookie(app:&App, token:&str, age:i64) -> HeaderValue {
    HeaderValue::from_str(&format!("dtrp_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={age}{}",if app.secure_cookie{"; Secure"}else{""})).unwrap()
}
async fn register(State(app):State<App>, ConnectInfo(addr):ConnectInfo<SocketAddr>, h:HeaderMap, Json(v):Json<Value>) -> ApiResult<Response> {
    csrf(&h)?;
    auth_limit(&app,format!("register:{}",addr.ip()))?;
    let name=text(&v,"name",1,40)?;
    let email=text(&v,"email",3,160)?.to_lowercase();
    if !email.contains('@') || email.contains(char::is_whitespace) { return Err(bad("请输入有效邮箱")); }
    let password=text(&v,"password",8,128)?;
    let hash=tokio::task::spawn_blocking(move || {
        Argon2::default().hash_password(password.as_bytes(),&SaltString::generate(&mut OsRng)).map(|h|h.to_string())
    }).await.map_err(|_|bad("密码处理失败"))?.map_err(|_|bad("密码处理失败"))?;
    let mut c=app.db.lock().unwrap();
    if c.query_row("SELECT count(*) FROM users WHERE email=?", [&email], |r|r.get::<_,i64>(0))?>0 { return Err(bad("该邮箱已注册，请直接登录")); }
    let tx=c.transaction()?;
    let id=uid();
    tx.execute("INSERT INTO users(id,name,email,password_hash,created_at) VALUES(?,?,?,?,?)",params![id,name,email,hash,now()])?;
    let token=format!("{}{}",uid(),uid());
    tx.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",params![digest(&token),id,now()+30*86400])?;
    tx.commit()?;
    Ok(([(header::SET_COOKIE,cookie(&app,&token,30*86400))],Json(json!({"user":{"id":id,"name":name,"email":email}}))).into_response())
}
async fn login(State(app):State<App>, ConnectInfo(addr):ConnectInfo<SocketAddr>, h:HeaderMap, Json(v):Json<Value>) -> ApiResult<Response> {
    csrf(&h)?;
    auth_limit(&app,format!("login:{}",addr.ip()))?;
    let email=text(&v,"email",3,160)?.to_lowercase();
    let password=text(&v,"password",1,128)?;
    let record={
        let c=app.db.lock().unwrap();
        c.query_row("SELECT id,name,password_hash FROM users WHERE email=?", [&email], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()?
    };
    let (id,name,hash)=record.unwrap_or(("".into(),"".into(),"$argon2id$v=19$m=19456,t=2,p=1$c29tZXJhbmRvbXNhbHQ$C03H6xHv2XnHw9Z/3exHCRhB2wGGFvC3E3Cdl/kq5gY".into()));
    let valid=tokio::task::spawn_blocking(move || PasswordHash::new(&hash).is_ok_and(|h|Argon2::default().verify_password(password.as_bytes(),&h).is_ok())).await.unwrap_or(false);
    if id.is_empty() || !valid { return Err(ApiError(StatusCode::UNAUTHORIZED,"邮箱或密码不正确".into())); }
    let token=format!("{}{}",uid(),uid());
    let c=app.db.lock().unwrap();
    c.execute("DELETE FROM sessions WHERE expires_at<=?",[now()])?;
    c.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",params![digest(&token),id,now()+30*86400])?;
    Ok(([(header::SET_COOKIE,cookie(&app,&token,30*86400))],Json(json!({"user":{"id":id,"name":name,"email":email}}))).into_response())
}
async fn logout(State(app):State<App>, h:HeaderMap) -> ApiResult<Response> {
    csrf(&h)?;
    let c=app.db.lock().unwrap();
    if let Ok(user)=auth(&c,&h) {
        let token=h.get(header::COOKIE).and_then(|x|x.to_str().ok()).unwrap_or("").split(';').find_map(|x|x.trim().strip_prefix("dtrp_session=")).unwrap_or("");
        c.execute("DELETE FROM sessions WHERE token_hash=? AND user_id=?",params![digest(token),user])?;
    }
    Ok(([(header::SET_COOKIE,cookie(&app,"",0))],Json(json!({"ok":true}))).into_response())
}
#[derive(Deserialize)]
struct StateQuery { group_id:Option<String> }
async fn get_state(State(app):State<App>, h:HeaderMap, Query(q):Query<StateQuery>) -> ApiResult<Json<Value>> {
    let c=app.db.lock().unwrap();
    let user=auth(&c,&h)?;
    let profile=c.query_row("SELECT id,name,email FROM users WHERE id=?", [&user], |r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"email":r.get::<_,String>(2)?})))?;
    let groups=collect(&c,"SELECT g.id,g.name,m.role,g.invite_code,g.settings,(SELECT count(*) FROM memberships WHERE group_id=g.id) FROM groups g JOIN memberships m ON g.id=m.group_id WHERE m.user_id=? ORDER BY g.created_at",&[&user],|r|{
        let role:String=r.get(2)?;
        Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"invite_code":if role=="organizer"{r.get::<_,String>(3)?}else{String::new()},"settings":parse_json(r.get(4)?),"member_count":r.get::<_,i64>(5)?,"role":role}))
    })?;
    let chosen=q.group_id.or_else(||groups.first().and_then(|g|g["id"].as_str().map(str::to_owned)));
    let notifications=collect(&c,"SELECT n.id,n.group_id,n.decision_id,n.kind,n.message,n.created_at,n.read_at,d.title FROM notifications n LEFT JOIN decisions d ON n.decision_id=d.id WHERE n.user_id=? ORDER BY n.created_at DESC,n.rowid DESC LIMIT 100",&[&user],|r|Ok(json!({"id":r.get::<_,String>(0)?,"group_id":r.get::<_,String>(1)?,"decision_id":r.get::<_,Option<String>>(2)?,"kind":r.get::<_,String>(3)?,"message":r.get::<_,String>(4)?,"created_at":r.get::<_,i64>(5)?,"read_at":r.get::<_,Option<i64>>(6)?,"title":r.get::<_,Option<String>>(7)?})))?;
    let unread:i64=c.query_row("SELECT count(*) FROM notifications WHERE user_id=? AND read_at IS NULL",[&user],|r|r.get(0))?;
    let mut out=json!({"user":profile,"groups":groups,"group_id":chosen,"group":null,"decisions":[],"folders":[],"members":[],"notifications":notifications,"unread_count":unread,"server_time":now()});
    if let Some(group)=chosen {
        role(&c,&group,&user)?;
        out["group"]=out["groups"].as_array().unwrap().iter().find(|x|x["id"]==group).cloned().unwrap();
        let ds=collect(&c,&format!("{DECISION_SELECT} WHERE group_id=? ORDER BY deadline,created_at"),&[&group],decision_row)?;
        out["decisions"]=json!(ds.into_iter().map(|d|summarize(&c,d,&user)).collect::<ApiResult<Vec<_>>>()?);
        out["folders"]=json!(collect(&c,"SELECT id,name,parent_id,kind,automatic FROM folders WHERE group_id=? ORDER BY created_at",&[&group],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"parent_id":r.get::<_,Option<String>>(2)?,"kind":r.get::<_,String>(3)?,"automatic":r.get::<_,bool>(4)?})))?);
        out["members"]=json!(collect(&c,"SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON m.user_id=u.id WHERE m.group_id=? ORDER BY m.joined_at",&[&group],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"role":r.get::<_,String>(2)?})))?);
    }
    Ok(Json(out))
}
async fn get_decision(State(app):State<App>, h:HeaderMap, Path(id):Path<String>) -> ApiResult<Json<Value>> {
    let c=app.db.lock().unwrap();
    let user=auth(&c,&h)?;
    let mut d=summarize(&c,decision(&c,&id,&user)?,&user)?;
    d["options"]=json!(collect(&c,"SELECT id,title,details,creator_id,created_at,archived,source_ids FROM options WHERE decision_id=? ORDER BY created_at,rowid",&[&id],option_row)?);
    d["comments"]=json!(collect(&c,"SELECT c.id,c.option_id,c.user_id,u.name,c.body,c.created_at FROM comments c JOIN users u ON c.user_id=u.id WHERE c.decision_id=? ORDER BY c.created_at,c.rowid",&[&id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"option_id":r.get::<_,Option<String>>(1)?,"user_id":r.get::<_,String>(2)?,"name":r.get::<_,String>(3)?,"body":r.get::<_,String>(4)?,"created_at":r.get::<_,i64>(5)?})))?);
    d["subdecisions"]=json!(collect(&c,&format!("{DECISION_SELECT} WHERE parent_id=? ORDER BY created_at"),&[&id],decision_row)?.into_iter().map(|d|summarize(&c,d,&user)).collect::<ApiResult<Vec<_>>>()?);
    d["ballots"]=json!(collect(&c,"SELECT user_id,selected_ids,version,updated_at FROM ballots WHERE decision_id=?",&[&id],ballot_row)?);
    Ok(Json(d))
}
async fn events(State(app):State<App>,h:HeaderMap) -> ApiResult<Sse<impl tokio_stream::Stream<Item=Result<Event,Infallible>>>> {
    let (user,expires)={
        let c=app.db.lock().unwrap();
        let user=auth(&c,&h)?;
        let token=h.get(header::COOKIE).and_then(|x|x.to_str().ok()).unwrap_or("").split(';').find_map(|x|x.trim().strip_prefix("dtrp_session=")).unwrap_or("");
        let expires=c.query_row("SELECT expires_at FROM sessions WHERE token_hash=?",[digest(token)],|r|r.get::<_,i64>(0))?;
        (user,expires)
    };
    let shutdown=app.shutdown.clone();
    let stream=BroadcastStream::new(app.events.subscribe()).filter_map(move |item| {
        let _=&user;
        if now()>=expires { return None; }
        match item { Ok(_) | Err(_) => Some(Ok(Event::default().data("refresh"))) }
    }).take_while(move |_| !shutdown.load(Ordering::Relaxed) && now()<expires);
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(20)).text("connected")))
}
fn deadline(v:&Value,limit:Option<i64>) -> ApiResult<i64> {
    let n=if let Some(n)=v["deadline"].as_i64(){n}else{
        DateTime::parse_from_rfc3339(&string(v,"deadline")).map_err(|_|bad("截止时间格式不正确"))?.timestamp()
    };
    if n<=now()+30 {return Err(bad("截止时间至少需要在 30 秒之后"));}
    if n>now()+5*366*86400 {return Err(bad("截止时间不能超过五年"));}
    if limit.is_some_and(|p|n>p) {return Err(bad("子决策必须在母决策结束前完成"));}
    Ok(n)
}
fn tags(v:&Value)->ApiResult<Value>{
    if v.get("tags").is_none(){return Ok(json!([]));}
    let arr=v["tags"].as_array().ok_or_else(||bad("标签格式不正确"))?;
    if arr.len()>15{return Err(bad("一个决策最多使用 15 个标签"));}
    let mut clean=Vec::new();
    for tag in arr{
        let t=tag.as_str().unwrap_or("").trim();
        if t.is_empty()||t.chars().count()>20{return Err(bad("标签需为 1 到 20 字符"));}
        if !clean.contains(&t){clean.push(t);}
    }
    Ok(json!(clean))
}
fn insert_option(c:&Connection,d:&str,title:&str,details:&str,user:&str,source:Value)->ApiResult<String>{
    let id=uid();
    c.execute("INSERT INTO options(id,decision_id,title,details,creator_id,created_at,source_ids) VALUES(?,?,?,?,?,?,?)",params![id,d,title,details,user,now(),source.to_string()])?;
    Ok(id)
}
fn insert_decision(c:&Connection,g:&str,parent:Option<&str>,kind:&str,v:&Value,user:&str,settings:Value,payload:Value)->ApiResult<String>{
    let id=uid();
    let title=text(v,"title",1,160)?;
    let description=text(v,"description",0,12000)?;
    let limit=if let Some(p)=parent{Some(c.query_row("SELECT deadline FROM decisions WHERE id=?",[p],|r|r.get::<_,i64>(0))?)}else{None};
    let due=deadline(v,limit)?;
    let importance=bounded(v,"importance",2,1,3)?;
    let tags=tags(v)?;
    let multi=kind!="merge"&&v["multi_select"].as_bool().unwrap_or(false);
    c.execute("INSERT INTO decisions(id,group_id,parent_id,kind,title,description,deadline,importance,tags,creator_id,settings,merge_payload,created_at,multi_select) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params![id,g,parent,kind,title,description,due,importance,tags.to_string(),user,settings.to_string(),payload.to_string(),now(),multi])?;
    Ok(id)
}
fn maybe_folder(c:&Connection,g:&str,parent:&str,settings:&Value)->ApiResult<()>{
    let threshold=settings["auto_folder_threshold"].as_i64().unwrap_or(3);
    let count:i64=c.query_row("SELECT count(*) FROM decisions WHERE parent_id=? AND kind='merge'",[parent],|r|r.get(0))?;
    if count>threshold{
        let existing=c.query_row("SELECT id FROM folders WHERE parent_id=? AND kind='merge' AND automatic=1",[parent],|r|r.get::<_,String>(0)).optional()?;
        let folder=existing.unwrap_or_else(uid);
        c.execute("INSERT OR IGNORE INTO folders(id,group_id,parent_id,name,kind,automatic,created_at) VALUES(?,?,?,'合并决策','merge',1,?)",params![folder,g,parent,now()])?;
        c.execute("UPDATE decisions SET folder_id=? WHERE parent_id=? AND kind='merge' AND folder_id IS NULL",params![folder,parent])?;
    }
    Ok(())
}
fn close_decision(c:&Connection,id:&str,actor:&str)->ApiResult<Value>{
    let d=c.query_row(&format!("{DECISION_SELECT} WHERE id=?"),[id],decision_row)?;
    if d["status"]!="open"{return Err(bad("该决策已经结束"));}
    let group=d["group_id"].as_str().unwrap();
    let title=d["title"].as_str().unwrap();
    let mut outcome="completed";
    if d["kind"]=="merge"{
        let options=collect(c,"SELECT id,title,details,creator_id,created_at,archived,source_ids FROM options WHERE decision_id=? ORDER BY rowid",&[&id],option_row)?;
        let yes=options.iter().find(|x|x["title"]=="同意合并").ok_or_else(missing)?["id"].as_str().unwrap();
        let no=options.iter().find(|x|x["title"]=="保留原选项").ok_or_else(missing)?["id"].as_str().unwrap();
        let ballots=collect(c,"SELECT user_id,selected_ids,version,updated_at FROM ballots WHERE decision_id=?",&[&id],ballot_row)?;
        let count_yes=ballots.iter().filter(|x|x["selected_ids"].as_array().unwrap().contains(&json!(yes))).count();
        let count_no=ballots.iter().filter(|x|x["selected_ids"].as_array().unwrap().contains(&json!(no))).count();
        outcome="rejected";
        if count_yes>count_no&&count_yes>0{
            let parent=d["parent_id"].as_str().unwrap();
            let status:String=c.query_row("SELECT status FROM decisions WHERE id=?",[parent],|r|r.get(0))?;
            let sources=ids(&d["merge_payload"],"source_ids",2)?;
            let mut valid=status=="open";
            let mut detail_parts=Vec::new();
            for source in &sources{
                let opt=c.query_row("SELECT title,details,archived FROM options WHERE id=? AND decision_id=?",params![source,parent],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,bool>(2)?))).optional()?;
                if let Some((title,details,archived))=opt{
                    if archived{valid=false;}
                    detail_parts.push(format!("{title}\n{details}"));
                }else{valid=false;}
            }
            if valid{
                for source in &sources{c.execute("UPDATE options SET archived=1 WHERE id=?",[source])?;}
                let title=text(&d["merge_payload"],"merged_title",1,160)?;
                let details=format!("{}\n\n合并来源：\n{}",string(&d["merge_payload"],"merged_details"),detail_parts.join("\n\n"));
                insert_option(c,parent,&title,&details,actor,json!(sources))?;
                c.execute("UPDATE decisions SET version=version+1 WHERE id=?",[parent])?;
                outcome="passed";
                for member in members(c,group)?{
                    notify(c,group,Some(parent),&member,"merged","选项已完成合并，请查看新选项并重新确认你的选择",&format!("merged:{id}:{member}"))?;
                }
            }else{outcome="conflict";}
        }
    }
    c.execute("UPDATE decisions SET status='closed',outcome=?,closed_at=? WHERE id=?",params![outcome,now(),id])?;
    let message=match outcome{
        "passed"=>format!("「{title}」表决通过，已完成选项合并"),
        "rejected"=>format!("「{title}」未通过，保留原选项；同票或无人投票也不执行合并"),
        "conflict"=>format!("「{title}」源选项或母决策已变化，未执行合并，请重新发起提案"),
        _=>format!("「{title}」已结束，查看最终结果"),
    };
    for member in members(c,group)?{notify(c,group,Some(id),&member,"closed",&message,&format!("closed:{id}:{member}"))?;}
    audit(c,group,actor,"close_decision",&json!({"id":id,"outcome":outcome}))?;
    Ok(json!({"id":id,"outcome":outcome}))
}
fn dispatch(tx:&Transaction<'_>,user:&str,v:&Value)->ApiResult<Value>{
    let action=string(v,"action");
    match action.as_str(){
        "create_group"=>{
            let name=text(v,"name",1,80)?;
            let id=uid();
            let invite=uid()[..12].to_uppercase();
            tx.execute("INSERT INTO groups(id,name,invite_code,settings,created_at) VALUES(?,?,?,?,?)",params![id,name,invite,default_settings().to_string(),now()])?;
            tx.execute("INSERT INTO memberships(group_id,user_id,role,joined_at) VALUES(?,?,'organizer',?)",params![id,user,now()])?;
            if v["with_examples"].as_bool().unwrap_or(false){seed_examples(tx,&id,user)?;}
            Ok(json!({"id":id,"invite_code":invite}))
        }
        "join_group"=>{
            let code=text(v,"invite_code",1,40)?.to_uppercase();
            let group=tx.query_row("SELECT id FROM groups WHERE invite_code=?",[&code],|r|r.get::<_,String>(0)).optional()?.ok_or_else(||bad("邀请码不正确，请向组织者确认"))?;
            tx.execute("INSERT OR IGNORE INTO memberships(group_id,user_id,role,joined_at) VALUES(?,?,'member',?)",params![group,user,now()])?;
            audit(tx,&group,user,"join_group",&json!({}))?;
            Ok(json!({"id":group}))
        }
        "settings"=>{
            let group=text(v,"group_id",1,80)?;
            leader(tx,&group,user)?;
            let settings=validate_settings(&v["settings"],group_settings(tx,&group)?)?;
            let name=text(v,"name",1,80)?;
            tx.execute("UPDATE groups SET name=?,settings=? WHERE id=?",params![name,settings.to_string(),group])?;
            // Group permissions remain live for existing decisions; per-decision reminder settings are retained.
            let ds=collect(tx,&format!("{DECISION_SELECT} WHERE group_id=?"),&[&group],decision_row)?;
            for d in ds{
                let mut ds=d["settings"].clone();
                for key in ["allow_add_options","allow_merge","allow_rename_subdecision","reminder_permission","sub_notify_on_create","auto_folder_threshold"]{ds[key]=settings[key].clone();}
                tx.execute("UPDATE decisions SET settings=? WHERE id=?",params![ds.to_string(),d["id"].as_str()])?;
            }
            let parents=collect(tx,&format!("{DECISION_SELECT} WHERE group_id=? AND parent_id IS NULL"),&[&group],decision_row)?;
            for d in parents{maybe_folder(tx,&group,d["id"].as_str().unwrap(),&settings)?;}
            audit(tx,&group,user,"settings",&settings)?;
            Ok(json!({"ok":true}))
        }
        "create_decision"=>{
            let group=text(v,"group_id",1,80)?;
            leader(tx,&group,user)?;
            let settings=validate_settings(&v["settings"],group_settings(tx,&group)?)?;
            let options=v["options"].as_array().ok_or_else(||bad("请至少填写两个选项"))?;
            if options.len()<2||options.len()>50{return Err(bad("请提供 2 到 50 个选项"));}
            let id=insert_decision(tx,&group,None,"main",v,user,settings,Value::Null)?;
            for o in options{insert_option(tx,&id,&text(o,"title",1,160)?,&text(o,"details",0,8000)?,user,json!([]))?;}
            for member in members(tx,&group)?{
                if member!=user{notify(tx,&group,Some(&id),&member,"new_decision",&format!("有新决策「{}」邀请你参与",string(v,"title")),&format!("new:{id}:{member}"))?;}
            }
            audit(tx,&group,user,"create_decision",&json!({"id":id}))?;
            Ok(json!({"id":id}))
        }
        "create_folder"=>{
            let group=text(v,"group_id",1,80)?;
            leader(tx,&group,user)?;
            let name=text(v,"name",1,80)?;
            let parent=v["parent_id"].as_str();
            if let Some(p)=parent{
                let d=decision(tx,p,user)?;
                if d["group_id"]!=group{return Err(denied());}
            }
            let id=uid();
            tx.execute("INSERT INTO folders(id,group_id,parent_id,name,kind,automatic,created_at) VALUES(?,?,?,?,'custom',0,?)",params![id,group,parent,name,now()])?;
            Ok(json!({"id":id}))
        }
        "move_decisions"=>{
            let group=text(v,"group_id",1,80)?;
            leader(tx,&group,user)?;
            let selections=ids(v,"decision_ids",1)?;
            let folder=v["folder_id"].as_str();
            let folder_parent=if let Some(f)=folder{
                Some(tx.query_row("SELECT parent_id FROM folders WHERE id=? AND group_id=?",params![f,group],|r|r.get::<_,Option<String>>(0)).optional()?.ok_or_else(missing)?)
            }else{None};
            for id in selections{
                let d=decision(tx,&id,user)?;
                if d["group_id"]!=group{return Err(denied());}
                if let Some(ref parent)=folder_parent{
                    if d["parent_id"]!=json!(parent){return Err(bad("文件夹与决策需要位于同一层级"));}
                }
                tx.execute("UPDATE decisions SET folder_id=? WHERE id=?",params![folder,id])?;
            }
            Ok(json!({"ok":true}))
        }
        "read_notifications"=>{
            if let Some(id)=v["id"].as_str(){tx.execute("UPDATE notifications SET read_at=? WHERE id=? AND user_id=?",params![now(),id,user])?;}
            else{tx.execute("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL",params![now(),user])?;}
            Ok(json!({"ok":true}))
        }
        _=>{
            let id=text(v,"decision_id",1,80)?;
            let d=decision(tx,&id,user)?;
            let group=d["group_id"].as_str().unwrap();
            let is_leader=role(tx,group,user)?=="organizer";
            match action.as_str(){
                "vote"=>{
                    ensure_open(&d)?;
                    let selected=ids(v,"option_ids",1)?;
                    if !d["multi_select"].as_bool().unwrap_or(false)&&selected.len()!=1{return Err(bad("此决策只能选择一个选项"));}
                    if v["version"].as_i64()!=d["version"].as_i64(){return Err(ApiError(StatusCode::CONFLICT,"选项已更新，请查看新选项后重新提交".into()));}
                    for opt in &selected{
                        let n:i64=tx.query_row("SELECT count(*) FROM options WHERE id=? AND decision_id=? AND archived=0",params![opt,id],|r|r.get(0))?;
                        if n!=1{return Err(bad("选项已变化，请刷新后重新选择"));}
                    }
                    tx.execute("INSERT INTO ballots(decision_id,user_id,selected_ids,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(decision_id,user_id) DO UPDATE SET selected_ids=excluded.selected_ids,version=excluded.version,updated_at=excluded.updated_at",params![id,user,json!(selected).to_string(),d["version"].as_i64(),now()])?;
                    audit(tx,group,user,"vote",&json!({"decision_id":id,"option_ids":selected,"version":d["version"]}))?;
                    Ok(json!({"ok":true}))
                }
                "add_option"=>{
                    ensure_open(&d)?;
                    if d["kind"]=="merge"{return Err(bad("合并表决的选项固定为同意或保留"));}
                    if !is_leader&&d["settings"]["allow_add_options"]!=true{return Err(denied());}
                    let n:i64=tx.query_row("SELECT count(*) FROM options WHERE decision_id=? AND archived=0",[&id],|r|r.get(0))?;
                    if n>=100{return Err(bad("一个决策最多保留 100 个有效选项"));}
                    let option=insert_option(tx,&id,&text(v,"title",1,160)?,&text(v,"details",0,8000)?,user,json!([]))?;
                    tx.execute("UPDATE decisions SET version=version+1 WHERE id=?",[&id])?;
                    audit(tx,group,user,"add_option",&json!({"decision_id":id,"option_id":option}))?;
                    Ok(json!({"id":option}))
                }
                "comment"=>{
                    let body=text(v,"body",1,4000)?;
                    let option=v["option_id"].as_str();
                    if let Some(opt)=option{
                        if tx.query_row("SELECT count(*) FROM options WHERE id=? AND decision_id=?",params![opt,id],|r|r.get::<_,i64>(0))?!=1{return Err(missing());}
                    }
                    let cid=uid();
                    tx.execute("INSERT INTO comments(id,decision_id,option_id,user_id,body,created_at) VALUES(?,?,?,?,?,?)",params![cid,id,option,user,body,now()])?;
                    Ok(json!({"id":cid}))
                }
                "merge"=>{
                    ensure_open(&d)?;
                    if d["kind"]=="merge"{return Err(bad("不能对固定表决选项再次发起合并"));}
                    if !is_leader&&d["settings"]["allow_merge"]!=true{return Err(denied());}
                    let sources=ids(v,"source_ids",2)?;
                    for source in &sources{
                        let n:i64=tx.query_row("SELECT count(*) FROM options WHERE id=? AND decision_id=? AND archived=0",params![source,id],|r|r.get(0))?;
                        if n!=1{return Err(bad("请选择有效且尚未合并的选项"));}
                    }
                    let merged_title=text(v,"merged_title",1,160)?;
                    let details=text(v,"merged_details",0,8000)?;
                    let mut create=v.clone();
                    if string(v,"title").is_empty(){create["title"]=json!("合并决策");}
                    create["description"]=json!(format!("提议将 {} 个选项合并为「{}」。严格多数通过后自动执行；同票、无人投票或来源冲突时保留原选项。",sources.len(),merged_title));
                    create["tags"]=d["tags"].clone();
                    create["importance"]=d["importance"].clone();
                    let payload=json!({"source_ids":sources,"merged_title":merged_title,"merged_details":details});
                    let child=insert_decision(tx,group,Some(&id),"merge",&create,user,d["settings"].clone(),payload)?;
                    insert_option(tx,&child,"同意合并","结束时同意票多于保留票，且至少一人同意，即执行合并。",user,json!([]))?;
                    insert_option(tx,&child,"保留原选项","保留当前选项，不执行此次合并。",user,json!([]))?;
                    maybe_folder(tx,group,&id,&d["settings"])?;
                    if d["settings"]["sub_notify_on_create"]==true{
                        for member in members(tx,group)?{notify(tx,group,Some(&child),&member,"merge_request",&format!("「{}」新增了合并提案，邀请你参与表决",d["title"].as_str().unwrap()),&format!("proposal:{child}:{member}"))?;}
                    }
                    audit(tx,group,user,"merge_request",&json!({"id":child,"parent_id":id}))?;
                    Ok(json!({"id":child}))
                }
                "rename_decision"=>{
                    if !is_leader&&!(d["kind"]=="merge"&&d["creator_id"]==user&&d["settings"]["allow_rename_subdecision"]==true){return Err(denied());}
                    let title=text(v,"title",1,160)?;
                    tx.execute("UPDATE decisions SET title=? WHERE id=?",params![title,id])?;
                    Ok(json!({"ok":true}))
                }
                "update_decision"=>{
                    if !is_leader{return Err(denied());}
                    ensure_open(&d)?;
                    let due=deadline(v,if let Some(p)=d["parent_id"].as_str(){Some(decision(tx,p,user)?["deadline"].as_i64().unwrap())}else{None})?;
                    let max_child:Option<i64>=tx.query_row("SELECT max(deadline) FROM decisions WHERE parent_id=? AND status='open'",[&id],|r|r.get(0))?;
                    if max_child.is_some_and(|x|x>due){return Err(bad("截止时间不能早于仍在进行的子决策"));}
                    let settings=validate_settings(&v["settings"],d["settings"].clone())?;
                    tx.execute("UPDATE decisions SET title=?,description=?,deadline=?,importance=?,tags=?,settings=? WHERE id=?",params![text(v,"title",1,160)?,text(v,"description",0,12000)?,due,bounded(v,"importance",2,1,3)?,tags(v)?.to_string(),settings.to_string(),id])?;
                    audit(tx,group,user,"update_decision",&json!({"id":id}))?;
                    Ok(json!({"ok":true}))
                }
                "remind"=>{
                    ensure_open(&d)?;
                    if d["kind"]=="main"&&!is_leader{return Err(denied());}
                    if d["kind"]=="merge"{
                        let p=d["settings"]["reminder_permission"].as_str().unwrap_or("both");
                        if (p=="organizer"&&!is_leader)||(p=="members"&&is_leader){return Err(denied());}
                    }
                    let audience=string(v,"audience");
                    if !["all","unvoted","stale"].contains(&audience.as_str()){return Err(bad("提醒对象不正确"));}
                    let sent=remind_targets(tx,&d,&audience,"manual",&uid())?;
                    audit(tx,group,user,"remind",&json!({"id":id,"audience":audience,"count":sent}))?;
                    Ok(json!({"sent":sent}))
                }
                "close_decision"=>{
                    if !is_leader{return Err(denied());}
                    if d["kind"]=="main"{
                        let children=collect(tx,&format!("{DECISION_SELECT} WHERE parent_id=? AND status='open'"),&[&id],decision_row)?;
                        for child in children{close_decision(tx,child["id"].as_str().unwrap(),user)?;}
                    }
                    close_decision(tx,&id,user)
                }
                _=>Err(bad("未知操作")),
            }
        }
    }
}
fn remind_targets(c:&Connection,d:&Value,audience:&str,kind:&str,batch:&str)->ApiResult<usize>{
    let id=d["id"].as_str().unwrap();
    let group=d["group_id"].as_str().unwrap();
    let mut sent=0;
    for member in members(c,group)?{
        let version=c.query_row("SELECT version FROM ballots WHERE decision_id=? AND user_id=?",params![id,member],|r|r.get::<_,i64>(0)).optional()?;
        let target=match audience{"all"=>true,"unvoted"=>version.is_none(),_=>version.unwrap_or(0)<d["version"].as_i64().unwrap_or(1)};
        if target{
            let suffix=if d["version"].as_i64().unwrap_or(1)>1{"选项有更新，请查看并确认你的最新选择"}else{"请在截止前参与决策"};
            let key=format!("{kind}:{id}:{batch}:{member}");
            let existing:i64=c.query_row("SELECT count(*) FROM notifications WHERE dedupe_key=?",[&key],|r|r.get(0))?;
            if existing==0{
                notify(c,group,Some(id),&member,kind,&format!("「{}」{suffix}",d["title"].as_str().unwrap()),&key)?;
                sent+=1;
            }
        }
    }
    Ok(sent)
}
fn scheduler(c:&mut Connection)->ApiResult<usize>{
    let tx=c.transaction()?;
    let open=collect(&tx,&format!("{DECISION_SELECT} WHERE status='open' ORDER BY CASE kind WHEN 'merge' THEN 0 ELSE 1 END,deadline"),&[],decision_row)?;
    let mut changes=0;
    let t=now();
    for d in open{
        let id=d["id"].as_str().unwrap();
        if d["deadline"].as_i64().unwrap()<=t{
            let already:String=tx.query_row("SELECT status FROM decisions WHERE id=?",[id],|r|r.get(0))?;
            if already=="open"{close_decision(&tx,id,"system")?;changes+=1;}
        }else{
            let key=if d["kind"]=="merge"{"sub_remind_minutes"}else{"remind_minutes"};
            let mins=d["settings"][key].as_i64().unwrap_or(30);
            if t>=d["deadline"].as_i64().unwrap()-mins*60{
                changes+=remind_targets(&tx,&d,d["settings"]["reminder_audience"].as_str().unwrap_or("stale"),"scheduled",&d["version"].to_string())?;
            }
        }
    }
    tx.execute("DELETE FROM sessions WHERE expires_at<=?",[t])?;
    tx.commit()?;
    Ok(changes)
}
async fn action(State(app):State<App>,h:HeaderMap,Json(v):Json<Value>)->ApiResult<Json<Value>>{
    csrf(&h)?;
    let result={
        let mut c=app.db.lock().unwrap();
        let user=auth(&c,&h)?;
        let tx=c.transaction()?;
        let result=dispatch(&tx,&user,&v)?;
        tx.commit()?;
        result
    };
    app.publish();
    Ok(Json(result))
}
fn seed_examples(c:&Connection,g:&str,u:&str)->ApiResult<()>{
    let samples=[
        ("下一次团队共创日，去哪里？","一起选一个适合放松、交流和碰撞灵感的地方。欢迎补充交通、预算与活动建议。",3,vec!["日常"],6*3600,vec![("城郊露营","半小时车程，有草坪和咖啡。预算约 150 元/人，适合户外交流。"),("城市漫步","沿河散步，再找一家安静的小店吃晚餐。交通方便，预算约 100 元/人。"),("桌游与晚餐","室内活动不受天气影响，分组玩桌游后一起聚餐。预算约 120 元/人。")]),
        ("新版本先解决哪个问题？","本周只能投入一个完整开发周期，请结合用户反馈和实现成本做出判断。可以在选项下方补充依据。",3,vec!["产品","研发"],2*3600,vec![("改进首次使用引导","降低新成员加入和完成第一次操作的成本。"),("提升页面加载速度","优化列表加载与静态资源，先解决日常高频卡顿。"),("完善数据导出","支持团队归档与复盘，减少手工整理。")]),
        ("下周分享会，聊点什么？","选择你最感兴趣的主题。这个决策支持多选，也欢迎提出新主题。",1,vec!["日常"],30*3600,vec![("最近学到的小技巧","每个人分享一个能立即用起来的方法。"),("一次有意思的失败","复盘过程与决策，讨论下次可以怎样改进。")]),
    ];
    for (i,(title,desc,importance,tg,seconds,opts)) in samples.into_iter().enumerate(){
        let v=json!({"title":title,"description":desc,"deadline":now()+seconds,"importance":importance,"tags":tg,"multi_select":i==2});
        let id=insert_decision(c,g,None,"main",&v,u,default_settings(),Value::Null)?;
        for (title,details) in opts{insert_option(c,&id,title,details,u,json!([]))?;}
    }
    Ok(())
}
fn init(c:&Connection)->Result<(),rusqlite::Error>{
    c.busy_timeout(Duration::from_secs(10))?;
    c.execute_batch("
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=DELETE;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,invite_code TEXT UNIQUE NOT NULL,settings TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships(group_id TEXT NOT NULL REFERENCES groups(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,joined_at INTEGER NOT NULL,PRIMARY KEY(group_id,user_id));
    CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id),parent_id TEXT REFERENCES decisions(id),name TEXT NOT NULL,kind TEXT NOT NULL,automatic INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id),parent_id TEXT REFERENCES decisions(id),kind TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,deadline INTEGER NOT NULL,importance INTEGER NOT NULL,tags TEXT NOT NULL,folder_id TEXT REFERENCES folders(id),creator_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'open',version INTEGER NOT NULL DEFAULT 1,settings TEXT NOT NULL,merge_payload TEXT NOT NULL,created_at INTEGER NOT NULL,closed_at INTEGER,outcome TEXT,multi_select INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS options(id TEXT PRIMARY KEY,decision_id TEXT NOT NULL REFERENCES decisions(id),title TEXT NOT NULL,details TEXT NOT NULL,creator_id TEXT NOT NULL,created_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,source_ids TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS ballots(decision_id TEXT NOT NULL REFERENCES decisions(id),user_id TEXT NOT NULL REFERENCES users(id),selected_ids TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(decision_id,user_id));
    CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,decision_id TEXT NOT NULL REFERENCES decisions(id),option_id TEXT REFERENCES options(id),user_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id),decision_id TEXT REFERENCES decisions(id),user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,message TEXT NOT NULL,dedupe_key TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL,read_at INTEGER);
    CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,user_id TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_decisions_group ON decisions(group_id,deadline);
    CREATE INDEX IF NOT EXISTS idx_decisions_parent ON decisions(parent_id);
    CREATE INDEX IF NOT EXISTS idx_options_decision ON options(decision_id);
    CREATE INDEX IF NOT EXISTS idx_comments_decision ON comments(decision_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    ")
}
#[tokio::main]
async fn main(){
    let root=PathBuf::from(std::env::var("DTRP_ROOT").unwrap_or_else(|_|".".into()));
    std::fs::create_dir_all(root.join("data")).expect("create data directory");
    let database_path=std::env::var("DTRP_DATABASE").unwrap_or_else(|_|root.join("data/decisions.sqlite3").to_string_lossy().to_string());
    let database_lock=std::fs::OpenOptions::new().create(true).read(true).write(true).open(format!("{database_path}.lock")).expect("open database lock");
    database_lock.try_lock().expect("another instance is already using this database");
    let mut db=Connection::open(database_path).expect("open database");
    init(&db).expect("initialize database");
    scheduler(&mut db).expect("initial scheduler");
    let (event_tx,_)=broadcast::channel(128);
    let app=App{db:Arc::new(Mutex::new(db)),events:event_tx,attempts:Arc::new(Mutex::new(HashMap::new())),secure_cookie:std::env::var("DTRP_SECURE_COOKIE").as_deref()==Ok("1"),shutdown:Arc::new(AtomicBool::new(false))};
    let worker=app.clone();
    tokio::spawn(async move{
        let mut interval=tokio::time::interval(Duration::from_secs(15));
        loop{
            interval.tick().await;
            let work=worker.clone();
            let result=tokio::task::spawn_blocking(move||scheduler(&mut work.db.lock().unwrap())).await;
            match result{Ok(Ok(n)) if n>0=>worker.publish(),Ok(Err(e))=>eprintln!("scheduler: {e:?}"),Err(e)=>eprintln!("scheduler task: {e}"),_=>{}}
        }
    });
    let shutdown_app=app.clone();
    let router=Router::new()
        .route("/api/health",get(||async{Json(json!({"status":"ok","service":"group-decision","version":"0.1.0","time":now()}))}))
        .route("/api/register",post(register))
        .route("/api/login",post(login))
        .route("/api/logout",post(logout))
        .route("/api/state",get(get_state))
        .route("/api/decisions/{id}",get(get_decision))
        .route("/api/events",get(events))
        .route("/api/action",post(action))
        .fallback_service(ServeDir::new(root.join("static")).append_index_html_on_directories(true))
        .layer(axum::extract::DefaultBodyLimit::max(512*1024))
        .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS,HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::if_not_present(header::REFERRER_POLICY,HeaderValue::from_static("same-origin")))
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL,HeaderValue::from_static("no-store")))
        .layer(SetResponseHeaderLayer::if_not_present(header::CONTENT_SECURITY_POLICY,HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")))
        .with_state(app);
    let bind=std::env::var("DTRP_BIND").unwrap_or_else(|_|"0.0.0.0:18760".into());
    let listener=tokio::net::TcpListener::bind(&bind).await.expect("bind address");
    println!("群策已启动：http://{bind}");
    axum::serve(listener,router.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(async move{let _=tokio::signal::ctrl_c().await;shutdown_app.shutdown.store(true,Ordering::Relaxed);let _=shutdown_app.events.send("shutdown".into());}).await.expect("serve");
}
