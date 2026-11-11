const {createHash}=require('node:crypto');
const vars={FACTORY_ENABLED:'true',FACTORY_MAX_TICKETS_PER_DAY:'2',FACTORY_MAX_CODING_ATTEMPTS_PER_TICKET:'2',
  FACTORY_MAX_REVIEWS_PER_TICKET:'2',FACTORY_MAX_AUTOMATIC_RETRIES:'1',FACTORY_MAX_CONCURRENT_TICKETS:'1',
  FACTORY_TIMEZONE:'Europe/Bucharest',FACTORY_RUN_TIMEOUT_MINUTES:'15',FACTORY_MAX_TURNS_PER_RUN:'20',
  FACTORY_APP_URL:'https://haide-software-factory.onrender.com'};
const head='a'.repeat(40);
const context={repository:'haideearus/cypress-realworld-app',actor:'haideearus',triggeringActor:'haideearus',
  ref:'refs/heads/main',event:'workflow_dispatch',runId:'100',runAttempt:1,ticket:10,phase:'code',slot:'cycle1',head};
class GitHubFixture {
  constructor(){this.head=null;this.objects=new Map();this.failWrites=false;this.calls=[];this.sequence=0;}
  object(value){const sha=createHash('sha1').update(`${++this.sequence}:${JSON.stringify(value)}`).digest('hex');this.objects.set(sha,value);return sha;}
  fetch=async(url,options={})=>{
    const path=new URL(url).pathname.replace('/repos/haideearus/cypress-realworld-app','');
    const method=options.method||'GET'; const body=options.body?JSON.parse(options.body):null;
    this.calls.push({url:String(url),method,body});
    const response=(status,data)=>new Response(data===null?null:JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
    if(this.failWrites&&method!=='GET')return response(503,{message:'private fixture failure'});
    if(method==='GET'&&path==='/git/ref/heads/factory/state')
      return this.head?response(200,{ref:'refs/heads/factory/state',object:{sha:this.head,type:'commit'}}):response(404,{message:'Not Found'});
    if(method==='GET'&&path==='/contents/state.json'){
      const ref=new URL(url).searchParams.get('ref');const commit=this.objects.get(ref);
      const tree=commit&&this.objects.get(commit.tree);const entry=tree?.tree.find(x=>x.path==='state.json');
      const blob=entry&&this.objects.get(entry.sha);
      return blob?response(200,{type:'file',path:'state.json',sha:entry.sha,encoding:'base64',content:blob.content}):response(404,{message:'Not Found'});
    }
    if(method==='POST'&&['/git/blobs','/git/trees','/git/commits'].includes(path))return response(201,{sha:this.object(body)});
    if(method==='POST'&&path==='/git/refs'){
      if(this.head)return response(422,{message:'Reference already exists'});
      this.head=body.sha;return response(201,{ref:body.ref,object:{sha:this.head}});
    }
    if(method==='PATCH'&&path==='/git/refs/heads/factory/state'){
      const commit=this.objects.get(body.sha);
      if(body.force!==false||!commit?.parents.includes(this.head))return response(422,{message:'Not a fast forward'});
      this.head=body.sha;return response(200,{ref:'refs/heads/factory/state',object:{sha:this.head}});
    }
    return response(404,{message:`Unsupported fixture route ${method} ${path}`});
  };
}
module.exports={vars,head,context,GitHubFixture};
