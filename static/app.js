'use strict';
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=(x)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={
 home:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
 grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 clock:'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 check:'m5 12 4 4L19 6',
 circleCheck:'m8 12 3 3 5-6 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
 folder:'M3 7V4h6l2 3h10v13H3z',
 plus:'M12 5v14 M5 12h14',
 chevron:'m9 5 7 7-7 7',
 down:'m6 9 6 6 6-6',
 search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
 bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',
 chat:'M21 15a3 3 0 0 1-3 3H8l-5 3V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
 merge:'M6 3v3c0 4 12 4 12 9v6 M18 3v3c0 4-12 4-12 9v6 M3 18l3 3 3-3 M15 18l3 3 3-3',
 settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 2h6l1 4 4 1 2 5-3 3v5l-5 2-3-3H6l-4-5 2-4V6z',
 flag:'M4 22V3 M4 3c5-4 9 4 16 0v11c-7 4-11-4-16 0',
 arrow:'M19 12H5 m7-7-7 7 7 7',
 close:'M6 6l12 12 M6 18 18 6',
 copy:'M9 9h12v12H9z M15 5V3H3v12h2',
 logout:'M9 3H3v18h6 M10 12h12 m-4-4 4 4-4 4',
 menu:'M3 6h18 M3 12h18 M3 18h18',
 edit:'m15 4 5 5 M4 20l4-1L21 6l-4-4L4 15z',
 spark:'m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z',
 tag:'M21 13 11 3H3v8l10 10z M7 7h.01',
 shield:'M12 2 3 6v6c0 6 9 10 9 10s9-4 9-10V6z M8 12l3 3 5-6',
 inbox:'M3 4h18v16H3z M3 13h5l2 3h4l2-3h5',
 more:'M4 12h.01 M12 12h.01 M20 12h.01',
};
function icon(name){return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="'+(paths[name]||paths.grid)+'"/></svg>'}
const brand=()=>'<div class="brand"><span class="brand-mark">群</span><span>群策<small>TOGETHER, WE DECIDE</small></span></div>';
let serverOffset=0;
let S=null,D=null,view='today',tab='open',sort=localStorage.getItem('qunce-sort')||'time',search='',selected=new Set(),mergeMode=false,mergeSelected=new Set(),voteDraft=new Map();
let desiredDetailId=null;
let currentGroup=localStorage.getItem('qunce-group')||'',eventSource=null,connected=false,refreshTimer=null,loadSeq=0,authMode='login',mobileOpen=false,detailReturn='today',modalType='',modalContext=null;
const root=$('#app'),modalRoot=$('#modal-root');
function clock(){return Date.now()/1000+serverOffset}
function isOpen(d){return d.status==='open'&&d.deadline>clock()}
function nameOf(id){return S?.members?.find(x=>x.id===id)?.name||'团队成员'}
function initials(name){return [...String(name||'群')].slice(-2).join('')}
function dateTime(t,full=false){return new Date(t*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',...(full?{year:'numeric'}:{})})}
function relative(t){
 const n=t-Date.now()/1000;
 if(n<=0)return '已到截止时间';
 if(n<3600)return Math.ceil(n/60)+' 分钟后截止';
 if(n<86400)return (n/3600).toFixed(n<7200?1:0)+' 小时后截止';
 return Math.ceil(n/86400)+' 天后截止';
}
function elapsed(t){const n=Date.now()/1000-t;if(n<60)return '刚刚';if(n<3600)return Math.floor(n/60)+' 分钟前';if(n<86400)return Math.floor(n/3600)+' 小时前';return dateTime(t)}
function localInput(t){const d=new Date(t*1000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}
function isLeader(){return S?.group?.role==='organizer'}
function activeMain(){return (S?.decisions||[]).filter(x=>!x.parent_id&&isOpen(x))}
function pending(d){return isOpen(d)&&(!d.my_vote||d.needs_review)}
function importance(n){return '<span class="pill '+({3:'high',2:'medium',1:'low'}[n]||'low')+'">'+icon('flag')+({3:'重要',2:'普通',1:'低优先'}[n]||'普通')+'</span>'}
function outcome(d){return ({passed:'已合并',rejected:'未通过',conflict:'来源冲突',completed:'已结束'}[d.outcome]||'已结束')}
function toast(message,error=false){const el=document.createElement('div');el.className='toast'+(error?' error':'');el.textContent=message;$('#toast-root').append(el);setTimeout(()=>el.remove(),4500)}
async function api(path,body){
 const r=await fetch('/api'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 let value;try{value=await r.json()}catch{throw new Error('服务器返回了无法读取的内容')}
 if(!r.ok){const error=new Error(value.error||'请求失败，请稍后重试');error.status=r.status;throw error}
 return value;
}
async function mutate(action,payload={}){return api('/action',{action,...payload})}
function draftSnapshot(){
 const inputs=$$('[data-draft]',root).filter(el=>el.dataset.draft!=='search').map(el=>({key:el.dataset.draft,value:el.value,checked:el.checked}));
 const active=document.activeElement;
 return {inputs,focus:active?.dataset.draft,start:active?.selectionStart,end:active?.selectionEnd};
}
function restoreDrafts(s){
 for(const d of s.inputs){const el=$$('[data-draft]',root).find(x=>x.dataset.draft===d.key);if(el){el.value=d.value;if(['checkbox','radio'].includes(el.type))el.checked=d.checked}}
 if(s.focus){const el=$$('[data-draft]',root).find(x=>x.dataset.draft===s.focus);if(el){el.focus({preventScroll:true});try{el.setSelectionRange(s.start,s.end)}catch{}}}
}
async function load(options={}){
 const quiet=!!options.quiet;
 if(Object.prototype.hasOwnProperty.call(options,'detailId'))desiredDetailId=options.detailId;
 const detailId=desiredDetailId;
 const seq=++loadSeq;
 try{
  let state;
  try{state=await api('/state'+(currentGroup?'?group_id='+encodeURIComponent(currentGroup):''))}
  catch(e){if(e.status===403&&currentGroup){currentGroup='';state=await api('/state')}else throw e}
  let detail=null;
  if(detailId&&state.group_id)detail=await api('/decisions/'+encodeURIComponent(detailId));
  if(seq!==loadSeq)return;
  if(detail&&D?.id===detail.id&&detail.version!==D.version){voteDraft.delete(detail.id);toast('选项已更新，请查看后重新选择')}
  serverOffset=state.server_time-Date.now()/1000;S=state;currentGroup=S.group_id||'';if(currentGroup)localStorage.setItem('qunce-group',currentGroup);
  D=detail;render();
  if(!eventSource)startEvents();
 }catch(e){
  if(e.status===401){S=null;D=null;if(eventSource)eventSource.close();eventSource=null;renderAuth()}
  else if(!quiet)toast(e.message,true);
 }
}
function startEvents(){
 if(eventSource)eventSource.close();
 eventSource=new EventSource('/api/events');
 eventSource.onopen=()=>{connected=true;updateConnection();};
 eventSource.onerror=()=>{connected=false;updateConnection();};
 eventSource.onmessage=()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>load({quiet:true}),300)};
}
function updateConnection(){const el=$('#connection');if(el){el.className='live'+(connected?'':' off');el.innerHTML='<span class="live-dot"></span>'+(connected?'实时同步':'正在重连')}}
function navButton(key,label,ico,count){return '<button class="nav-item '+(view===key&&!D?'active':'')+'" data-act="view" data-view="'+esc(key)+'">'+icon(ico)+'<span>'+esc(label)+'</span>'+(count?'<span class="counter">'+count+'</span>':'')+'</button>'}
function sidebar(){
 const active=activeMain(),folders=S.folders.filter(x=>!x.parent_id),group=S.group;
 return '<aside class="sidebar '+(mobileOpen?'open':'')+'">'+brand()+
 '<button class="space-switch" data-act="spaces"><span class="space-symbol">'+icon('users')+'</span><span class="space-info"><strong>'+esc(group?.name||'选择你的空间')+'</strong><small>'+(group?group.member_count+' 位成员 · '+(isLeader()?'组织者':'组员'):'开始一次共同决策')+'</small></span>'+icon('down')+'</button>'+
 (group?'<div class="nav-section"><div class="nav-label">工作空间</div>'+navButton('today','今日决策','home',active.length)+navButton('pending','等待我参与','clock',active.filter(pending).length)+navButton('all','全部决策','grid')+navButton('children','子决策','merge')+navButton('closed','已结束','circleCheck')+'</div>'+
 '<div class="nav-section"><div class="folder-title"><span>决策文件夹</span>'+(isLeader()?'<button class="icon-button icon-sm" data-act="folder" aria-label="新建文件夹">'+icon('plus')+'</button>':'')+'</div>'+
 (folders.length?folders.map(f=>navButton('folder:'+f.id,f.name,'folder')).join(''):'<p class="muted"></p><div class="nav-label">尚无文件夹</div>')+'</div>'+
 '<div class="nav-section"><div class="nav-label">团队管理</div>'+navButton('members','空间成员','users')+(isLeader()?navButton('settings','空间设置','settings'):'')+'</div>':'')+
 '<div class="sidebar-bottom">'+(isLeader()?'<div class="invite-card"><strong>好决定，需要更多人的参与</strong><p>邀请伙伴加入，一起讨论与选择。</p><button data-act="invite">'+icon('plus')+'邀请成员</button></div>':'<div class="invite-card"><strong>每个观点，都值得被听见</strong><p>参与讨论，也可以提出新的选项。</p></div>')+
 '<div class="sidebar-foot">群策 v0.1 · 一起做决定</div></div></aside>';
}
function topbar(){
 return '<header class="topbar"><div class="flex gap"><button class="icon-button mobile-menu" data-act="mobile" aria-label="打开导航">'+icon('menu')+'</button><div class="breadcrumb">'+icon('grid')+'<span>工作空间</span><span>/</span><strong>'+esc(S.group?.name||'欢迎使用群策')+'</strong></div></div>'+
 '<div class="top-actions"><div id="connection" class="live"><span class="live-dot"></span>'+(connected?'实时同步':'连接中')+'</div><button class="icon-button notification-button" data-act="notifications" aria-label="通知中心">'+icon('bell')+(S.unread_count?'<span class="notification-dot">'+Math.min(S.unread_count,99)+'</span>':'')+'</button>'+
 '<button class="profile" data-act="profile"><span class="avatar">'+esc(initials(S.user.name))+'</span><span>'+esc(S.user.name)+'</span>'+icon('down')+'</button></div></header>';
}
function render(){
 if(!S){renderAuth();return}
 const snap=draftSnapshot();
 root.innerHTML='<div class="layout">'+sidebar()+'<main class="main">'+topbar()+'<div class="workspace">'+(!S.group?welcome():D?detailView():view==='settings'?settingsView():view==='members'?membersView():listView())+'</div></main></div>';
 $$('form[data-form=settings] [name]',root).forEach(el=>el.dataset.draft='settings-'+el.name);restoreDrafts(snap);updateConnection();
}
function renderAuth(){
 root.innerHTML='<main class="auth-layout"><section class="auth-art">'+brand()+'<div class="auth-copy"><div class="eyebrow">MAKE ROOM FOR EVERY VOICE</div><h1>一个人的想法，<br>一群人的好决定。</h1><p>从提出问题，到讨论、选择与形成共识。<br>让每个观点，都有参与的机会。</p><div class="auth-graphic" aria-hidden="true"><div class="line"></div><div class="line short"></div><div class="choice active"><span class="dot"></span>让每个人都参与进来'+icon('check')+'</div><div class="choice"><span class="dot"></span>把讨论变成共同的决定</div></div></div><small>群策 · TOGETHER, WE DECIDE</small></section>'+
 '<section class="auth-form-wrap"><div class="auth-form"><div class="auth-mobile-brand">'+brand()+'</div><h2>'+(authMode==='register'?'从一次共同决策开始':'欢迎回到群策')+'</h2><p>'+(authMode==='register'?'创建账号，邀请伙伴，一起做出更好的决定。':'登录你的工作空间，看看今天有哪些决定。')+'</p>'+
 '<form data-form="auth">'+(authMode==='register'?'<label class="field">你的称呼<input name="name" placeholder="团队成员如何称呼你" required maxlength="40" autocomplete="name"></label>':'')+
 '<label class="field">邮箱地址<input type="email" name="email" placeholder="you@example.com" required maxlength="160" autocomplete="email"></label>'+
 '<label class="field">密码<input type="password" name="password" placeholder="'+(authMode==='register'?'至少 8 位字符':'输入你的密码')+'" required minlength="'+(authMode==='register'?8:1)+'" maxlength="128" autocomplete="'+(authMode==='register'?'new-password':'current-password')+'"></label><div data-error></div><button class="btn primary" type="submit">'+(authMode==='register'?'创建账号':'登录工作空间')+icon('chevron')+'</button></form>'+
 '<div class="auth-switch">'+(authMode==='register'?'已经有账号？':'还没有账号？')+'<button data-act="auth-mode">'+(authMode==='register'?'直接登录':'创建一个账号')+'</button></div><div class="auth-note">'+icon('shield')+' 独立账号 · 团队权限 · 共同参与</div></div></section></main>';
}
function welcome(){return '<section class="welcome"><div class="eyebrow">LET’S DECIDE TOGETHER</div><h1>'+esc(S.user.name)+'，你好。</h1><p>创建一个团队空间，或加入伙伴已经创建的空间。</p><div class="welcome-cards"><article class="panel">'+icon('plus')+'<h3>开启一个新空间</h3><p>作为组织者，发起决策、邀请组员，并设置团队协作规则。</p><button class="btn primary" data-act="create-group">创建空间</button></article><article class="panel">'+icon('users')+'<h3>加入伙伴的空间</h3><p>输入组织者分享的邀请码，在自己的浏览器中参与实时决策。</p><button class="btn secondary" data-act="join-group">通过邀请码加入</button></article></div></section>'}
function stat(label,num,ico,unit){return '<div class="stat"><div><div class="stat-label">'+label+'</div><div class="stat-num">'+num+'<small>'+unit+'</small></div></div><div class="stat-icon">'+icon(ico)+'</div></div>'}
function listView(){
 const active=activeMain(),end=new Date();end.setHours(23,59,59,999);
 const titles={today:['今日决策','把观点汇聚起来，一起推进重要的事。'],pending:['等待我参与','你的想法，是共同决定的一部分。'],all:['全部决策','每一次讨论，每一个共同的选择。'],children:['子决策','通过独立表决，逐步解决更细的分歧。'],closed:['已结束','回看团队共同做出的决定。']};
 let [title,subtitle]=titles[view]||[S.folders.find(x=>'folder:'+x.id===view)?.name||'文件夹','把相关的决定放在一起。'];
 let items=S.decisions.filter(x=>{
  if(view==='children')return !!x.parent_id;
  if(view.startsWith('folder:'))return x.folder_id===view.slice(7);
  if(view==='closed')return x.status==='closed';
  if(x.parent_id)return false;
  if(view==='pending')return pending(x);
  return true;
 });
 if(!['closed','pending'].includes(view))items=items.filter(x=>tab==='all'||(tab==='open'?isOpen(x):!isOpen(x)));
 if(search)items=items.filter(x=>(x.title+' '+x.description+' '+x.tags.join(' ')).toLowerCase().includes(search.toLowerCase()));
 const tags=S.group.settings.tag_order||[],rank=d=>Math.min(999,...d.tags.map(x=>tags.indexOf(x)<0?999:tags.indexOf(x)));
 items.sort((a,b)=>{if(isOpen(a)!==isOpen(b))return isOpen(a)?-1:1;return sort==='importance'?b.importance-a.importance||a.deadline-b.deadline:sort==='tags'?rank(a)-rank(b)||a.deadline-b.deadline:a.deadline-b.deadline});
 const waiting=active.filter(pending).length;
 return '<div class="page-heading"><div><div class="eyebrow">'+new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'})+'</div><h1>'+esc(title)+'</h1><p>'+subtitle+'</p></div><div class="heading-tools">'+(isLeader()?'<button class="btn primary" data-act="new-decision">'+icon('plus')+'新建决策</button>':'')+'</div></div>'+
 '<div class="stats">'+stat('进行中的决策',active.length,'grid','项')+stat('等待我参与',waiting,'clock','项')+stat('今天截止',active.filter(x=>x.deadline*1000<=end.getTime()).length,'flag','项')+stat('空间成员',S.group.member_count,'users','人')+'</div>'+
 '<div class="nudge"><div class="nudge-icon">'+icon('spark')+'</div><div><h3>'+(waiting?'今天，还有 '+waiting+' 项决策等待你的想法':'每一个参与，都让共同的决定更进一步')+'</h3><p>'+(waiting?'看看最新选项，留下你的选择。新的观点也随时欢迎。':'你可以参与讨论、补充选项，或回看已经完成的决定。')+'</p></div><button class="btn" data-act="view" data-view="pending">去看看'+icon('chevron')+'</button></div>'+
 '<div class="section-heading"><h2>决策列表<span>'+items.length+' 项</span></h2><span class="muted"><small>截止时间与浏览器当地时区一致</small></span></div>'+
 '<div class="toolbar"><div class="filter-tabs">'+(['closed','pending'].includes(view)?'<button class="active">'+(view==='closed'?'已结束':'待参与')+'</button>':[['open','进行中'],['all','全部'],['closed','已结束']].map(([k,l])=>'<button data-act="tab" data-tab="'+k+'" class="'+(tab===k?'active':'')+'">'+l+'</button>').join(''))+'</div>'+
 '<div class="search-sort"><label class="search">'+icon('search')+'<input type="search" id="search" data-draft="search" placeholder="搜索决策或标签" aria-label="搜索决策" value="'+esc(search)+'"></label><select id="sort" class="sort-select" aria-label="排序方式"><option value="time" '+(sort==='time'?'selected':'')+'>按时间紧迫性</option><option value="importance" '+(sort==='importance'?'selected':'')+'>按重要性</option><option value="tags" '+(sort==='tags'?'selected':'')+'>按组织者标签顺序</option></select></div></div>'+
 (selected.size&&isLeader()?'<div class="bulk-bar"><strong>已选 '+selected.size+' 项</strong><button class="btn small secondary" data-act="bulk-folder">'+icon('folder')+'移动到文件夹</button><button class="btn small ghost" data-act="clear-selected">取消选择</button></div>':'')+
 '<div class="decision-grid">'+(items.length?items.map(card).join(''):'<div class="empty"><div class="empty-icon">'+icon('inbox')+'</div><h3>'+(search?'没有匹配的决策':'这里暂时没有决策')+'</h3><p>'+(search?'试试其他标题或标签。':view==='pending'?'已完成当前需要参与的决策，之后有更新会提醒你。':'从一个问题开始，把大家的想法汇聚起来。')+'</p>'+(!search&&isLeader()?'<button class="btn secondary" data-act="new-decision">'+icon('plus')+'发起一个决策</button>':'')+'</div>')+'</div><div class="footer-hint">'+icon('shield')+'你的选择与讨论保存在团队空间中</div>';
}
function card(d){
 const open=isOpen(d),members=S.group.member_count,percentage=Math.round(d.vote_count/Math.max(members,1)*100);
 return '<article class="decision-card"><div class="card-meta">'+importance(d.importance)+(d.kind==='merge'?'<span class="pill merge">合并表决</span>':'')+d.tags.map(t=>'<span class="pill tag">'+esc(t)+'</span>').join('')+(isLeader()?'<label class="card-select"><input type="checkbox" data-select-decision="'+esc(d.id)+'" '+(selected.has(d.id)?'checked':'')+' aria-label="选择 '+esc(d.title)+'"></label>':'')+'</div>'+
 '<button class="card-title" data-act="open" data-id="'+esc(d.id)+'">'+esc(d.title)+'</button><p class="card-description">'+esc(d.description||'打开详情，查看选项并参与讨论。')+'</p>'+
 '<div class="card-progress"><span>参与进度</span><strong>'+d.vote_count+' / '+members+' 人</strong></div><progress max="100" value="'+percentage+'" aria-label="'+percentage+'% 成员已投票"></progress>'+
 '<div class="flex spread"><div class="card-bottom-meta"><span>'+icon('grid')+d.option_count+' 个选项</span><span>'+icon('chat')+d.comment_count+' 条讨论</span></div><span class="pill '+(open?(d.needs_review?'warning':d.my_vote?'teal':''):'closed')+'">'+(open?(d.needs_review?'新选项待确认':d.my_vote?'已参与':'待参与'):outcome(d))+'</span></div>'+
 '<div class="card-footer"><span class="time-label '+(open&&d.deadline-Date.now()/1000<7200?'urgent':'')+'">'+icon('clock')+(open?relative(d.deadline):dateTime(d.deadline)+' 结束')+'</span><button class="btn small" data-act="open" data-id="'+esc(d.id)+'">'+(open?(d.my_vote?'查看详情':'参与决策'):'查看结果')+icon('chevron')+'</button></div></article>';
}
function detailView(){
 const d=D,open=isOpen(d),options=d.options.filter(x=>!x.archived),chosen=voteDraft.has(d.id)?voteDraft.get(d.id):(d.my_vote?.selected_ids||[]).filter(x=>options.some(o=>o.id===x));
 const mayAdd=open&&d.kind!=='merge'&&(isLeader()||d.settings.allow_add_options),mayMerge=open&&d.kind!=='merge'&&(isLeader()||d.settings.allow_merge);
 const canRename=isLeader()||(d.kind==='merge'&&d.creator_id===S.user.id&&d.settings.allow_rename_subdecision);
 const reminders=d.kind==='merge'?(d.settings.reminder_permission==='both'||(isLeader()?d.settings.reminder_permission==='organizer':d.settings.reminder_permission==='members')):isLeader();
 const source=d.kind==='merge'?S.decisions.find(x=>x.id===d.parent_id):null;
 return '<button class="back-link" data-act="'+(source?'open':'back')+'" '+(source?'data-id="'+esc(source.id)+'"':'')+'>'+icon('arrow')+(source?'返回母决策':'返回决策列表')+'</button>'+
 '<section class="panel detail-header"><div class="flex spread"><div class="card-meta">'+importance(d.importance)+(d.kind==='merge'?'<span class="pill merge">合并决策</span>':'')+d.tags.map(x=>'<span class="pill tag">'+esc(x)+'</span>').join('')+'<span class="pill '+(open?'teal':'closed')+'">'+(open?'进行中':outcome(d))+'</span></div><div class="heading-tools">'+(canRename?'<button class="btn small ghost" data-act="rename">'+icon('edit')+'重命名</button>':'')+(isLeader()&&open?'<button class="btn small secondary" data-act="edit-decision">编辑</button>':'')+'</div></div>'+
 '<h1>'+esc(d.title)+'</h1><div class="detail-meta"><span class="flex gap">'+icon('clock')+dateTime(d.deadline,true)+' 截止</span><span>'+esc(nameOf(d.creator_id))+' 发起</span><span>'+d.vote_count+' / '+S.group.member_count+' 人已参与</span><span>'+(d.multi_select?'可多选':'单选')+'</span></div><p>'+esc(d.description)+'</p></section>'+
 (d.needs_review&&open?'<div class="notice">'+icon('bell')+' 选项有更新，请查看最新选项，并重新确认你的选择。</div>':'')+
 (!open?'<div class="notice '+(d.outcome==='passed'?'success':'info')+'">'+(d.kind==='merge'?({passed:'合并提案已通过，母决策已生成新选项，原选项与讨论完整保留。',rejected:'此次合并未通过，原选项保持不变。',conflict:'源选项或母决策已发生变化，本次没有执行合并。'}[d.outcome]||'此次表决已结束。'):'决策已结束，以下为最终选择。你仍然可以继续讨论。')+'</div>':'')+
 '<div class="detail-layout"><div><section class="panel options-panel"><div class="panel-title"><h2>'+(open?'做出你的选择':'决策结果')+'<small>'+options.length+' 个选项 · '+(d.multi_select?'支持多选':'单项选择')+'</small></h2><div class="flex gap">'+(mayAdd?'<button class="btn small ghost" data-act="add-option">'+icon('plus')+'补充选项</button>':'')+(mayMerge?'<button class="btn small '+(mergeMode?'primary':'secondary')+'" data-act="merge-mode">'+icon('merge')+(mergeMode?'取消合并':'提议合并')+'</button>':'')+'</div></div>'+
 (mergeMode?'<div class="merge-mode-banner">勾选至少两个选项，发起一次合并表决。原选项会保留到表决通过后。</div>':'')+
 (d.kind==='merge'?'<div class="notice info">合并目标：'+esc(d.merge_payload.merged_title)+'<br>涉及 '+d.merge_payload.source_ids.length+' 个原选项；同意票严格多于保留票时通过。</div>':'')+
 options.map(o=>optionCard(o,d,chosen,open)).join('')+
 (open?'<div class="vote-footer"><p>'+(mergeMode?'已选择 '+mergeSelected.size+' 个待合并选项':d.my_vote?'已记录你的选择，截止前可以随时调整。':'选择后提交，团队就能看到你的想法。')+'</p><button class="btn primary" data-act="'+(mergeMode?'merge-form':'submit-vote')+'" '+((mergeMode?mergeSelected.size<2:!chosen.length)?'disabled':'')+'>'+icon(mergeMode?'merge':'check')+(mergeMode?'发起合并表决':d.my_vote?'确认最新选择':'提交选择')+'</button></div>':'')+
 (d.options.some(x=>x.archived)?'<details class="origin-list"><summary class="muted">查看已合并的原选项与讨论（'+d.options.filter(x=>x.archived).length+'）</summary>'+d.options.filter(x=>x.archived).map(o=>'<div class="option-card archived"><h3 class="option-title">'+esc(o.title)+'</h3><p class="option-details">'+esc(o.details)+'</p><button class="btn small ghost" data-act="option-discussion" data-id="'+esc(o.id)+'">'+icon('chat')+'查看原讨论</button></div>').join('')+'</details>':'')+'</section>'+
 discussion()+
 (d.kind!=='merge'?subdecisions():'')+
 '</div><aside class="detail-aside"><section class="panel side-panel"><h3>决策信息</h3><div class="info-row"><span>当前状态</span><strong>'+(open?'进行中':outcome(d))+'</strong></div><div class="info-row"><span>截止时间</span><strong>'+dateTime(d.deadline)+'</strong></div><div class="info-row"><span>选项版本</span><strong>第 '+d.version+' 版</strong></div><div class="info-row"><span>自动提醒</span><strong>截止前 '+(d.kind==='merge'?d.settings.sub_remind_minutes:d.settings.remind_minutes)+' 分钟</strong></div><div class="info-row"><span>提醒对象</span><strong>'+({all:'全体成员',stale:'未提交最新选择',unvoted:'尚未参与'}[d.settings.reminder_audience]||'未提交最新选择')+'</strong></div>'+
 (open&&reminders?'<button class="btn secondary" data-act="remind">'+icon('bell')+'提醒成员参与</button>':'')+(open&&isLeader()?'<button class="btn ghost" data-act="close-decision">提前结束'+(d.kind==='merge'?'并结算':'决策')+'</button>':'')+'</section>'+
 '<section class="panel side-panel"><h3>团队参与 <span class="muted">'+d.vote_count+'/'+S.group.member_count+'</span></h3>'+S.members.map(m=>{const b=d.ballots.find(x=>x.user_id===m.id);return '<div class="member-status"><span class="avatar small">'+esc(initials(m.name))+'</span><span>'+esc(m.name)+'</span><span class="status-label '+(b?'teal':'muted')+'">'+(b?(b.version<d.version?'待重新确认':'已参与'):'未参与')+'</span></div>'}).join('')+'</section>'+
 '<section class="panel side-panel"><h3>'+icon('shield')+' 关于共同决策</h3><p class="muted"><small>截止前可以调整选择。新增或合并选项后，系统会按组织者的规则提醒相关成员重新判断。</small></p></section></aside></div>';
}
function optionCard(o,d,chosen,open){
 const count=d.option_counts[o.id]||0,percentage=Math.round(count/Math.max(d.vote_count,1)*100),checked=mergeMode?mergeSelected.has(o.id):chosen.includes(o.id);
 const source=(o.source_ids||[]).length;
 return '<article class="option-card '+(checked?'chosen':'')+'"><div class="option-top">'+(open?'<input type="'+(mergeMode||d.multi_select?'checkbox':'radio')+'" name="decision-option" id="opt-'+o.id+'" data-option="'+o.id+'" '+(checked?'checked':'')+' aria-label="'+esc(o.title)+'">':'')+'<div class="option-info"><label class="option-title" '+(open?'for="opt-'+o.id+'"':'')+'>'+esc(o.title)+'</label><p class="option-details">'+esc(o.details||'暂未补充详情')+'</p></div></div>'+
 '<div class="option-result"><progress max="100" value="'+percentage+'" aria-label="'+count+' 票"></progress><span>'+count+'票 · '+percentage+'%</span></div><div class="option-stats"><span>'+esc(nameOf(o.creator_id))+' 提出'+(source?' · 由 '+source+' 项合并':'')+'</span><button class="btn small ghost" data-act="option-discussion" data-id="'+o.id+'">'+icon('chat')+'讨论 '+d.comments.filter(c=>c.option_id===o.id).length+(source?' · 查看来源':'')+'</button></div></article>';
}
function commentHtml(c){return '<article class="comment"><span class="avatar small">'+esc(initials(c.name))+'</span><div class="comment-main"><div class="comment-author"><strong>'+esc(c.name)+'</strong><time>'+elapsed(c.created_at)+'</time></div><p class="comment-body">'+esc(c.body)+'</p></div></article>'}
function commentForm(option=null){return '<form class="comment-form" data-form="comment" data-option-id="'+esc(option||'')+'"><textarea name="body" data-draft="comment-'+D.id+'-'+(option||'general')+'" placeholder="说说你的想法，或补充判断依据…" required maxlength="4000" aria-label="讨论内容"></textarea><div class="flex"><small class="muted">让讨论围绕问题，也尊重不同的声音。</small><button class="btn primary small" type="submit">'+icon('chat')+'发布讨论</button></div><div data-error></div></form>'}
function discussion(){const comments=D.comments.filter(x=>!x.option_id);return '<section class="panel discussion"><div class="panel-title"><h2>'+icon('chat')+' 问题讨论<small>'+comments.length+' 条讨论</small></h2></div>'+(comments.length?comments.map(commentHtml).join(''):'<p class="muted"><small>暂时还没有讨论。第一个想法，也许就来自你。</small></p>')+commentForm()+'</section>'}
function subdecisions(){
 const children=D.subdecisions,folders=S.folders.filter(f=>f.parent_id===D.id);
 let html='<section class="panel discussion"><div class="panel-title"><h2>'+icon('merge')+' 子决策<small>'+children.length+' 项</small></h2>'+(isLeader()?'<button class="btn small ghost" data-act="folder" data-parent="'+D.id+'">'+icon('folder')+'新建文件夹</button>':'')+'</div>';
 const block=(x)=>'<div class="subdecision">'+(isLeader()?'<input type="checkbox" data-select-child="'+x.id+'" '+(selected.has(x.id)?'checked':'')+' aria-label="选择子决策 '+esc(x.title)+'">':'')+icon('merge')+'<button data-act="open" data-id="'+x.id+'"><h4>'+esc(x.title)+'</h4><p>'+x.vote_count+' 人参与 · '+(isOpen(x)?relative(x.deadline):outcome(x))+'</p></button><span class="pill '+(isOpen(x)?'merge':'closed')+'">'+(isOpen(x)?'进行中':outcome(x))+'</span>'+icon('chevron')+'</div>';
 if(selected.size&&isLeader())html+='<div class="bulk-bar"><span>已选 '+selected.size+' 项</span><button class="btn small secondary" data-act="bulk-folder">移入文件夹</button><button class="btn small ghost" data-act="clear-selected">取消</button></div>';
 html+=children.filter(c=>!c.folder_id).map(block).join('');
 for(const f of folders){html+='<div class="folder-group-label">'+icon('folder')+esc(f.name)+(f.automatic?' · 自动归档':'')+'</div>'+children.filter(c=>c.folder_id===f.id).map(block).join('')}
 if(!children.length)html+='<p class="muted"><small>提出选项合并后，会在这里生成一个独立的表决。</small></p>';
 return html+'</section>';
}
function membersView(){return '<div class="page-heading"><div><h1>空间成员</h1><p>一起讨论、共同判断的 '+S.members.length+' 位伙伴。</p></div>'+(isLeader()?'<button class="btn primary" data-act="invite">'+icon('plus')+'邀请成员</button>':'')+'</div><section class="panel"><table class="member-table"><thead><tr><th>成员</th><th>角色</th><th>进行中参与情况</th></tr></thead><tbody>'+S.members.map(m=>'<tr><td><div class="flex"><span class="avatar">'+esc(initials(m.name))+'</span><span>'+esc(m.name)+(m.id===S.user.id?' <small class="muted">（我）</small>':'')+'</span></div></td><td><span class="pill '+(m.role==='organizer'?'teal':'')+'">'+(m.role==='organizer'?'组织者':'组员')+'</span></td><td class="muted">'+(m.id===S.user.id?activeMain().filter(x=>x.my_vote).length+' / '+activeMain().length+' 项':'在决策详情中查看')+'</td></tr>').join('')+'</tbody></table></section>'}
function settingsFields(s,full=true){
 return (full?'<div class="form-section"><h3>标签与排序</h3><p>按下方顺序排列标签，成员可选择“按组织者标签顺序”排序。</p><label class="field">标签顺序<input name="tag_order" value="'+esc((s.tag_order||[]).join('，'))+'" placeholder="产品，研发，日常"><small>使用逗号分隔；排在前面的标签优先。</small></label></div><div class="form-section"><h3>成员协作权限</h3>'+[
 ['allow_add_options','允许组员补充选项','组织者始终可以补充选项。'],
 ['allow_merge','允许组员提出选项合并','提交后生成独立的合并子决策。'],
 ['allow_rename_subdecision','允许发起者重命名自己的子决策','组织者始终可以重命名。']
 ].map(([k,t,d])=>'<label class="checkbox-row"><input type="checkbox" name="'+k+'" '+(s[k]?'checked':'')+'><span>'+t+'<small>'+d+'</small></span></label>').join('')+'</div>':'')+
 '<div class="form-section"><h3>决策提醒</h3><p>网页打开时实时接收，关闭网页后通知保存在通知中心。</p><div class="field-row"><label class="field">截止前提醒（分钟）<input type="number" name="remind_minutes" min="1" max="43200" value="'+s.remind_minutes+'" required></label><label class="field">自动提醒对象<select name="reminder_audience">'+[['stale','未提交最新选择的成员'],['unvoted','尚未参与的成员'],['all','全体成员']].map(([v,l])=>'<option value="'+v+'" '+(s.reminder_audience===v?'selected':'')+'>'+l+'</option>').join('')+'</select></label></div></div>'+
 '<div class="form-section"><h3>子决策规则</h3><div class="field-row"><label class="field">子决策截止前提醒（分钟）<input type="number" name="sub_remind_minutes" min="1" max="43200" required value="'+s.sub_remind_minutes+'"></label>'+(full?'<label class="field">谁可以手动提醒<select name="reminder_permission">'+[['organizer','仅组织者'],['members','仅组员'],['both','组织者与组员']].map(([v,l])=>'<option value="'+v+'" '+(s.reminder_permission===v?'selected':'')+'>'+l+'</option>').join('')+'</select></label>':'')+'</div>'+(full?'<label class="checkbox-row"><input type="checkbox" name="sub_notify_on_create" '+(s.sub_notify_on_create?'checked':'')+'><span>子决策发起时通知所有参与者<small>截止前自动提醒仍按上方规则执行。</small></span></label><label class="field">同类子决策超过以下数量时自动建文件夹<input type="number" name="auto_folder_threshold" min="1" max="50" required value="'+s.auto_folder_threshold+'"><small>在各自的母决策下整理；组织者也可以随时创建文件夹并批量移动。</small></label>':'')+'</div>';
}
function settingsView(){
 if(!isLeader())return '<div class="notice">仅组织者可以管理空间设置。</div>';
 const g=S.group;
 return '<div class="page-heading"><div><h1>空间设置</h1><p>给协作留出自由，也为共同决策设定规则。</p></div></div><div class="settings-layout"><form class="panel" data-form="settings"><div class="form-section"><h3>基本信息</h3><label class="field">空间名称<input name="name" value="'+esc(g.name)+'" maxlength="80" required></label></div>'+settingsFields(g.settings)+'<div data-error></div><div class="modal-footer"><button class="btn primary" type="submit">'+icon('check')+'保存设置</button></div></form><aside class="stack"><div class="panel side-panel"><h3>设置如何生效</h3><p class="muted"><small>权限变更会应用到现有决策。提醒时点作为新决策的默认值，现有决策可在各自详情中修改。</small></p></div><div class="panel side-panel"><h3>合并表决规则</h3><ul class="help-list"><li>每次可以选择两个或更多选项合并。</li><li>同意票必须严格多于保留票，且至少有一票同意。</li><li>通过后自动生成合并选项，原讨论与来源保留。</li><li>源选项发生冲突时不执行，避免覆盖其他决定。</li></ul></div></aside></div>';
}

let modalOpener=null;
function showModal(title,body,wide=false,type='',context=null){
 modalOpener=document.activeElement;modalType=type;modalContext=context;
 modalRoot.innerHTML='<div class="modal-overlay"><section class="modal '+(wide?'wide':'')+'" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">'+esc(title)+'</h2><button class="icon-button" data-act="modal-close" aria-label="关闭">'+icon('close')+'</button></div><div class="modal-body">'+body+'</div></section></div>';
 document.body.classList.add('modal-open');
 const el=$('input:not([type=hidden]),textarea,select,button',modalRoot);setTimeout(()=>el?.focus(),30);
}
function closeModal(){modalRoot.innerHTML='';modalType='';modalContext=null;document.body.classList.remove('modal-open');modalOpener?.focus?.({preventScroll:true})}
function formEnd(label='确定'){return '<div data-error></div><div class="modal-footer"><button type="button" class="btn ghost" data-act="modal-close">取消</button><button type="submit" class="btn primary">'+esc(label)+'</button></div>'}
function showSpaces(){
 showModal('我的空间','<p class="modal-subtitle">每个空间拥有独立的决策、成员和协作规则。</p>'+S.groups.map(g=>'<button class="space-list-item" data-act="switch-group" data-id="'+g.id+'"><span class="space-symbol">'+icon('users')+'</span><span class="space-info"><strong>'+esc(g.name)+'</strong><small>'+g.member_count+' 位成员</small></span><span class="pill '+(g.id===currentGroup?'teal':'')+'">'+(g.id===currentGroup?'当前空间':g.role==='organizer'?'组织者':'组员')+'</span></button>').join('')+'<div class="modal-footer"><button class="btn secondary" data-act="join-group">加入空间</button><button class="btn primary" data-act="create-group">'+icon('plus')+'创建空间</button></div>');
}
function showCreateGroup(){showModal('创建团队空间','<p class="modal-subtitle">你将成为空间组织者，可以设置决策规则并邀请成员。</p><form data-form="create-group"><label class="field">空间名称<input name="name" placeholder="例如：产品共创小组" maxlength="80" required></label><label class="checkbox-row"><input type="checkbox" name="with_examples" checked><span>添加三个示例决策<small>可直接参与和讨论，帮助团队了解使用方式。</small></span></label>'+formEnd('创建空间')+'</form>')}
function showJoin(){showModal('加入团队空间','<p class="modal-subtitle">向组织者获取 12 位邀请码，即可在自己的账号中参与决策。</p><form data-form="join-group"><label class="field">空间邀请码<input name="invite_code" placeholder="输入 12 位邀请码" maxlength="40" required autocomplete="off"></label>'+formEnd('加入空间')+'</form>')}
function showInvite(){
 if(!isLeader())return;
 showModal('邀请伙伴加入','<p class="modal-subtitle">将邀请码分享给伙伴。对方注册账号后，选择“通过邀请码加入”。</p><div class="code">'+esc(S.group.invite_code)+'</div><div class="modal-footer"><button class="btn primary" data-act="copy-invite">'+icon('copy')+'复制邀请码</button></div>');
}
function optionInput(i,title='',details=''){return '<div class="form-option"><div class="flex gap"><input name="option-title" placeholder="选项 '+i+' · 简洁描述" maxlength="160" value="'+esc(title)+'" required aria-label="选项名称"><button type="button" class="icon-button" data-act="remove-form-option" aria-label="移除此选项">'+icon('close')+'</button></div><textarea name="option-details" placeholder="补充详情、判断依据、成本或注意事项（可选）" maxlength="8000" aria-label="选项详情">'+esc(details)+'</textarea></div>'}
function decisionForm(edit=false){
 const d=edit?D:null,s=d?.settings||S.group.settings;
 showModal(edit?'编辑决策':'发起一个共同决策','<p class="modal-subtitle">说清楚问题，给出选项，也为新的想法留出空间。</p><form data-form="'+(edit?'edit-decision':'new-decision')+'"><label class="field">决策标题<input name="title" placeholder="这一次，我们需要一起决定什么？" maxlength="160" required value="'+esc(d?.title||'')+'"></label><label class="field">问题描述<textarea name="description" placeholder="补充背景、约束和希望大家考虑的因素…" maxlength="12000">'+esc(d?.description||'')+'</textarea></label><div class="field-row"><label class="field">截止时间<input name="deadline" type="datetime-local" value="'+localInput(d?.deadline||Date.now()/1000+86400)+'" required></label><label class="field">重要性<select name="importance">'+[[3,'重要'],[2,'普通'],[1,'低优先']].map(([k,l])=>'<option value="'+k+'" '+((d?.importance||2)===k?'selected':'')+'>'+l+'</option>').join('')+'</select></label></div><label class="field">标签<input name="tags" placeholder="使用逗号分隔，例如：产品，研发" value="'+esc((d?.tags||[]).join('，'))+'" maxlength="320"><small>组织者设置的标签顺序：'+esc(S.group.settings.tag_order.join(' → ')||'尚未设置')+'</small></label>'+
 (edit?'':'<div class="form-section"><h3>初始选项</h3><div id="form-options">'+optionInput(1)+optionInput(2)+'</div><button type="button" class="btn small secondary" data-act="add-form-option">'+icon('plus')+'再加一个选项</button><label class="checkbox-row"><input type="checkbox" name="multi_select"><span>允许选择多个选项<small>默认单选；合并子决策始终为单选。</small></span></label></div>')+
 '<details><summary class="muted">提醒设置</summary>'+settingsFields(s,false)+'</details>'+formEnd(edit?'保存修改':'发起决策')+'</form>',true);
}
function addOption(){showModal('补充一个新选项','<p class="modal-subtitle">新选项会同步给所有成员。系统将在设定的提醒时段，提醒符合条件的成员重新判断。</p><form data-form="add-option"><label class="field">选项名称<input name="title" maxlength="160" required placeholder="还有一种可能是…"></label><label class="field">选项详情<textarea name="details" maxlength="8000" placeholder="解释这个选项的内容与依据，帮助其他成员理解。"></textarea></label>'+formEnd('添加选项')+'</form>')}
function mergeForm(){
 if(mergeSelected.size<2){toast('请至少选择两个选项',true);return}
 const selectedOptions=D.options.filter(o=>mergeSelected.has(o.id)&&!o.archived);
 showModal('发起选项合并表决','<p class="modal-subtitle">合并先经过一次独立表决，通过后再自动生成新选项。</p><div class="notice info">选中的 '+selectedOptions.length+' 个选项：'+selectedOptions.map(o=>esc(o.title)).join('、')+'</div><form data-form="merge"><label class="field">子决策名称<input name="title" value="合并决策" maxlength="160" required></label><label class="field">合并后的选项名称<input name="merged_title" placeholder="为合并后的方案起一个名字" value="'+esc(selectedOptions.map(o=>o.title).join(' + ').slice(0,160))+'" maxlength="160" required></label><label class="field">合并说明<textarea name="merged_details" placeholder="为什么合并？合并后的方案有什么不同？" maxlength="8000"></textarea></label><label class="field">子决策截止时间<input type="datetime-local" name="deadline" required max="'+localInput(D.deadline)+'" value="'+localInput(Math.min(Date.now()/1000+3600,D.deadline))+'"><small>不得晚于母决策截止时间 '+dateTime(D.deadline)+'。</small></label><div class="notice">同意票多于保留票，且至少一人同意时执行合并。同票、无人投票或源选项冲突时保留原选项。</div>'+formEnd('发起表决')+'</form>',true);
}
function showRemind(){showModal('提醒成员参与','<p class="modal-subtitle">提醒会写入成员的通知中心，并实时同步到已打开的网页。</p><form data-form="remind"><label class="field">提醒哪些成员？<select name="audience"><option value="stale">尚未提交最新选择的成员</option><option value="unvoted">尚未参与的成员</option><option value="all">全体成员</option></select></label>'+formEnd('发送提醒')+'</form>')}
function showFolder(parent=null){showModal('创建决策文件夹','<p class="modal-subtitle">'+(parent?'在当前母决策下整理子决策。':'把同一主题的决策放在一起，之后可以批量移动。')+'</p><form data-form="folder" data-parent="'+esc(parent||'')+'"><label class="field">文件夹名称<input name="name" maxlength="80" required placeholder="例如：方案合并讨论"></label>'+formEnd('创建文件夹')+'</form>')}
function bulkFolder(){
 const ds=S.decisions.filter(d=>selected.has(d.id));
 if(!ds.length)return;
 const parent=ds[0].parent_id;
 if(ds.some(d=>d.parent_id!==parent)){toast('请选择同一母决策下的子决策，或同一层级的主决策',true);return}
 const folders=S.folders.filter(f=>f.parent_id===parent);
 showModal('批量整理决策','<p class="modal-subtitle">将选中的 '+ds.length+' 项决策移动到同一层级的文件夹。</p><form data-form="move"><label class="field">目标文件夹<select name="folder_id"><option value="">移出文件夹</option>'+folders.map(f=>'<option value="'+f.id+'">'+esc(f.name)+'</option>').join('')+'</select></label>'+(!folders.length?'<p class="muted"><small>还没有可用文件夹，可先在该层级创建一个。</small></p>':'')+formEnd('移动决策')+'</form>');
}
function showNotifications(){
 showModal('通知中心','<div class="flex spread modal-subtitle"><span>'+S.unread_count+' 条未读通知</span><button class="btn small ghost" data-act="read-all">全部标为已读</button></div>'+
 (S.notifications.length?S.notifications.map(n=>'<button class="notification-item '+(n.read_at?'':'unread')+'" data-act="notification" data-id="'+n.id+'" data-group="'+n.group_id+'" data-decision="'+esc(n.decision_id||'')+'"><span class="notification-symbol">'+icon(n.kind==='merge_request'?'merge':n.kind==='closed'?'circleCheck':'bell')+'</span><span><p>'+esc(n.message)+'</p><small>'+elapsed(n.created_at)+'</small></span>'+(!n.read_at?'<span class="unread-dot"></span>':'')+'</button>').join(''):'<div class="empty"><div class="empty-icon">'+icon('bell')+'</div><h3>暂无通知</h3><p>新的邀请、提醒和决策结果会出现在这里。</p></div>'),false,'notifications');
}
function showOption(id){
 const o=D.options.find(x=>x.id===id);if(!o)return;
 const comments=D.comments.filter(c=>c.option_id===id);
 const sources=(o.source_ids||[]).map(s=>D.options.find(x=>x.id===s)).filter(Boolean);
 showModal(o.title,'<p class="modal-subtitle">'+(o.archived?'原选项已合并，详情与讨论保留。':'选项详情与讨论')+'</p><p class="option-details">'+esc(o.details||'暂未补充详情')+'</p>'+
 (sources.length?'<section class="origin-list"><h4>合并来源与原讨论</h4>'+sources.map(s=>'<article class="origin-item"><h4>'+esc(s.title)+'</h4><p>'+esc(s.details)+'</p>'+D.comments.filter(c=>c.option_id===s.id).map(commentHtml).join('')+'<button class="btn small ghost" data-act="option-discussion" data-id="'+s.id+'">打开原选项讨论</button></article>').join('')+'</section>':'')+
 '<section class="origin-list"><h4>选项讨论 · '+comments.length+'</h4>'+(comments.length?comments.map(commentHtml).join(''):'<p class="muted"><small>围绕这个选项聊聊你的判断。</small></p>')+commentForm(id)+'</section>',true,'option',id);
}
function showProfile(){showModal('我的账号','<div class="flex gap modal-subtitle"><span class="avatar">'+esc(initials(S.user.name))+'</span><span>'+esc(S.user.name)+'<br>'+esc(S.user.email)+'</span></div><p class="muted"><small>每个账号使用独立登录状态；可在不同浏览器或设备中参与同一个空间。</small></p><div class="modal-footer"><button class="btn danger" data-act="logout">'+icon('logout')+'退出登录</button></div>')}
function readSettings(form,full=false){
 const f=new FormData(form),s={remind_minutes:Number(f.get('remind_minutes')),sub_remind_minutes:Number(f.get('sub_remind_minutes')),reminder_audience:f.get('reminder_audience')};
 if(full){
  s.tag_order=String(f.get('tag_order')||'').split(/[,，]/).map(x=>x.trim()).filter(Boolean);
  for(const k of ['allow_add_options','allow_merge','allow_rename_subdecision','sub_notify_on_create'])s[k]=f.has(k);
  s.reminder_permission=f.get('reminder_permission');s.auto_folder_threshold=Number(f.get('auto_folder_threshold'));
 }
 return s;
}
function getForm(form){return Object.fromEntries(new FormData(form))}
document.addEventListener('submit',async event=>{
 const form=event.target.closest('form[data-form]');if(!form)return;
 event.preventDefault();const submit=$('[type=submit]',form),error=$('[data-error]',form);if(error)error.innerHTML='';
 if(submit?.disabled)return;
 if(submit)submit.disabled=true;
 try{
  const f=getForm(form),type=form.dataset.form;
  if(type==='auth'){
   await api(authMode==='register'?'/register':'/login',f);currentGroup='';D=null;desiredDetailId=null;view='today';tab='open';await load();toast(authMode==='register'?'账号已创建，欢迎加入群策':'欢迎回来');return;
  }
  if(type==='create-group'){
   const r=await mutate('create_group',{name:f.name,with_examples:new FormData(form).has('with_examples')});currentGroup=r.id;view='today';tab='open';search='';selected.clear();D=null;closeModal();await load({detailId:null});toast('空间已创建，可以邀请伙伴加入了');return;
  }
  if(type==='join-group'){
   const r=await mutate('join_group',{invite_code:f.invite_code});currentGroup=r.id;view='today';tab='open';search='';selected.clear();D=null;closeModal();await load({detailId:null});toast('已加入团队空间');return;
  }
  if(type==='new-decision'||type==='edit-decision'){
   const payload={group_id:currentGroup,title:f.title,description:f.description,deadline:new Date(f.deadline).toISOString(),importance:Number(f.importance),tags:String(f.tags||'').split(/[,，]/).map(x=>x.trim()).filter(Boolean),settings:readSettings(form)};
   if(type==='new-decision'){payload.options=$$('.form-option',form).map(el=>({title:$('[name=option-title]',el).value,details:$('[name=option-details]',el).value}));payload.multi_select=new FormData(form).has('multi_select')}
   else payload.decision_id=D.id;
   const r=await mutate(type==='new-decision'?'create_decision':'update_decision',payload);
   closeModal();mergeMode=false;voteDraft.clear();await load({detailId:type==='new-decision'?r.id:D.id});toast(type==='new-decision'?'决策已发起':'决策信息已更新');return;
  }
  if(type==='settings'){await mutate('settings',{group_id:currentGroup,name:f.name,settings:readSettings(form,true)});await load();toast('空间设置已保存');return}
  if(type==='add-option'){await mutate('add_option',{decision_id:D.id,...f});closeModal();await load();toast('新选项已同步给团队成员');return}
  if(type==='merge'){
   const r=await mutate('merge',{decision_id:D.id,...f,source_ids:[...mergeSelected],deadline:new Date(f.deadline).toISOString()});
   closeModal();mergeMode=false;mergeSelected.clear();await load({detailId:r.id});toast('合并子决策已创建');return;
  }
  if(type==='rename'){await mutate('rename_decision',{decision_id:D.id,title:f.title});closeModal();await load();toast('名称已更新');return}
  if(type==='remind'){const r=await mutate('remind',{decision_id:D.id,audience:f.audience});closeModal();await load();toast('已向 '+r.sent+' 位成员发送提醒');return}
  if(type==='folder'){
   await mutate('create_folder',{group_id:currentGroup,name:f.name,parent_id:form.dataset.parent||null});closeModal();await load();toast('文件夹已创建');return;
  }
  if(type==='move'){await mutate('move_decisions',{group_id:currentGroup,decision_ids:[...selected],folder_id:f.folder_id||null});selected.clear();closeModal();await load();toast('已完成批量整理');return}
  if(type==='comment'){
   const option=form.dataset.optionId||null;
   await mutate('comment',{decision_id:D.id,option_id:option,body:f.body});
   const textarea=$('textarea',form);if(textarea)textarea.value='';
   await load();if(option)showOption(option);toast('讨论已发布');return;
  }
 }catch(e){
  if(error)error.innerHTML='<div class="form-error">'+esc(e.message)+'</div>';else toast(e.message,true);
 }finally{if(submit&&submit.isConnected)submit.disabled=false}
});
document.addEventListener('click',async event=>{
 const b=event.target.closest('[data-act]');if(!b||b.disabled)return;
 const act=b.dataset.act;
 try{
  switch(act){
   case 'auth-mode':authMode=authMode==='login'?'register':'login';renderAuth();break;
   case 'mobile':mobileOpen=!mobileOpen;$('.sidebar')?.classList.toggle('open',mobileOpen);break;
   case 'spaces':showSpaces();break;
   case 'create-group':showCreateGroup();break;
   case 'join-group':showJoin();break;
   case 'invite':showInvite();break;
   case 'copy-invite':{
    const code=S.group.invite_code;
    if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(code);toast('邀请码已复制')}
    else{const input=document.createElement('textarea');input.value=code;modalRoot.append(input);input.select();const copied=document.execCommand('copy');input.remove();toast(copied?'邀请码已复制':'请选中邀请码并复制')}
    break;
   }
   case 'switch-group':currentGroup=b.dataset.id;D=null;view='today';tab='open';search='';selected.clear();mergeMode=false;closeModal();await load({detailId:null});break;
   case 'view':desiredDetailId=null;view=b.dataset.view;tab=view==='all'||view==='children'?'all':'open';D=null;selected.clear();mergeMode=false;mobileOpen=false;search='';render();window.scrollTo(0,0);break;
   case 'tab':tab=b.dataset.tab;selected.clear();render();break;
   case 'new-decision':decisionForm(false);break;
   case 'edit-decision':decisionForm(true);break;
   case 'add-form-option':{const list=$('#form-options');if(list.children.length>=50){toast('最多 50 个初始选项',true);break}list.insertAdjacentHTML('beforeend',optionInput(list.children.length+1));break}
   case 'remove-form-option':if($$('.form-option',b.closest('form')).length<=2){toast('至少需要两个初始选项',true);break}b.closest('.form-option').remove();break;
   case 'open':detailReturn=D?detailReturn:view;selected.clear();mergeMode=false;mergeSelected.clear();await load({detailId:b.dataset.id});window.scrollTo(0,0);break;
   case 'back':desiredDetailId=null;D=null;view=detailReturn;selected.clear();mergeMode=false;render();window.scrollTo(0,0);break;
   case 'add-option':addOption();break;
   case 'merge-mode':mergeMode=!mergeMode;mergeSelected.clear();render();break;
   case 'merge-form':mergeForm();break;
   case 'submit-vote':{
    const options=D.options.filter(x=>!x.archived),choice=voteDraft.has(D.id)?voteDraft.get(D.id):(D.my_vote?.selected_ids||[]).filter(x=>options.some(o=>o.id===x));
    b.disabled=true;await mutate('vote',{decision_id:D.id,option_ids:choice,version:D.version});voteDraft.delete(D.id);await load();toast('你的选择已记录，截止前可以继续调整');break;
   }
   case 'rename':showModal('重命名决策','<form data-form="rename"><label class="field">决策名称<input name="title" value="'+esc(D.title)+'" required maxlength="160"></label>'+formEnd('保存名称')+'</form>');break;
   case 'remind':showRemind();break;
   case 'folder':showFolder(b.dataset.parent||null);break;
   case 'bulk-folder':bulkFolder();break;
   case 'clear-selected':selected.clear();render();break;
   case 'close-decision':showModal(D.kind==='merge'?'提前结束并结算合并表决':'提前结束决策','<p class="modal-subtitle">'+(D.kind==='merge'?'将按当前票数结算，通过则立即执行合并。':'将按当前选择结束决策，同时结算仍在进行的合并子决策。')+'结束后无法继续投票。</p><div class="modal-footer"><button class="btn ghost" data-act="modal-close">继续讨论</button><button class="btn danger" data-act="confirm-close">确认结束</button></div>');break;
   case 'confirm-close':b.disabled=true;await mutate('close_decision',{decision_id:D.id});closeModal();await load();toast('决策已结束，结果已同步');break;
   case 'option-discussion':showOption(b.dataset.id);break;
   case 'notifications':showNotifications();break;
   case 'read-all':await mutate('read_notifications');await load();showNotifications();break;
   case 'notification':{
    await mutate('read_notifications',{id:b.dataset.id});
    if(b.dataset.decision){currentGroup=b.dataset.group;selected.clear();mergeMode=false;closeModal();await load({detailId:b.dataset.decision})}
    else{await load();showNotifications()}
    break;
   }
   case 'profile':showProfile();break;
   case 'logout':await api('/logout',{});eventSource?.close();eventSource=null;S=null;D=null;desiredDetailId=null;currentGroup='';voteDraft.clear();closeModal();authMode='login';renderAuth();break;
   case 'modal-close':closeModal();break;
  }
 }catch(e){toast(e.message,true);if(b.isConnected)b.disabled=false}
});
document.addEventListener('change',event=>{
 const el=event.target;
 if(el.id==='sort'){sort=el.value;localStorage.setItem('qunce-sort',sort);render()}
 if(el.dataset.selectDecision){el.checked?selected.add(el.dataset.selectDecision):selected.delete(el.dataset.selectDecision);render()}
 if(el.dataset.selectChild){el.checked?selected.add(el.dataset.selectChild):selected.delete(el.dataset.selectChild);render()}
 if(el.dataset.option&&D){
  const id=el.dataset.option;
  if(mergeMode){el.checked?mergeSelected.add(id):mergeSelected.delete(id)}
  else{
   let chosen=voteDraft.has(D.id)?[...voteDraft.get(D.id)]:[...(D.my_vote?.selected_ids||[])].filter(x=>D.options.some(o=>o.id===x&&!o.archived));
   if(D.multi_select)chosen=el.checked?[...new Set([...chosen,id])]:chosen.filter(x=>x!==id);else chosen=[id];
   voteDraft.set(D.id,chosen);
  }
  render();
 }
});
let searchTimer=null;
document.addEventListener('input',event=>{if(event.target.id==='search'){search=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(()=>render(),140)}});
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'){if(modalRoot.children.length)closeModal();else if(mobileOpen){mobileOpen=false;$('.sidebar')?.classList.remove('open')}}
 if(event.key==='Tab'&&modalRoot.children.length){
  const items=$$('button:not(:disabled),a,input,select,textarea,[tabindex="0"]',modalRoot).filter(x=>x.offsetParent!==null);
  const first=items[0],last=items[items.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
 }
});
modalRoot.addEventListener('click',event=>{if(event.target.classList.contains('modal-overlay'))closeModal()});
document.addEventListener('click',event=>{if(mobileOpen&&!event.target.closest('.sidebar')&&!event.target.closest('[data-act=mobile]')){mobileOpen=false;$('.sidebar')?.classList.remove('open')}});
setInterval(()=>{if(S&&!document.hidden)load({quiet:true})},20000);
document.addEventListener('visibilitychange',()=>{if(S&&!document.hidden)load({quiet:true})});
load();
