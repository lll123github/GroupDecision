import hashlib,subprocess,tomllib,os
from pathlib import Path
p=Path(__file__).resolve().parent.parent
cache=next((p/'.toolchain/cargo/registry/cache').iterdir())
packages=tomllib.loads((p/'Cargo.lock').read_text())['package']
for pkg in packages:
 if not pkg.get('source'):continue
 name,version=pkg['name'],pkg['version']
 dest=cache/(name+'-'+version+'.crate')
 if dest.exists():continue
 temp=p/'.tmp'/('download-'+name+'.crate')
 for base in ['https://rsproxy.cn/api/v1/crates/'+name+'/'+version+'/download','https://mirror.sjtu.edu.cn/crates.io/crates/'+name+'/'+name+'-'+version+'.crate']:
  r=subprocess.run(['curl','--connect-timeout','4','--max-time','12','-fsSL',base,'-o',str(temp)],capture_output=True,text=True)
  if r.returncode==0 and hashlib.sha256(temp.read_bytes()).hexdigest()==pkg['checksum']:
   os.replace(temp,dest);print('VERIFIED',name,version,flush=True);break
 else:raise RuntimeError('download failed: '+name)
print('ALL_PACKAGES_VERIFIED',flush=True)
