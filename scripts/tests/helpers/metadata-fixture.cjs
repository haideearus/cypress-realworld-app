const {createHash}=require("node:crypto");
const {ROOT}=require("../../factory/github.cjs");
// In-memory Git object database; real stores retain all validation/CAS behavior.
class MetadataFixture {
 constructor(){this.refs=new Map();this.objects=new Map();this.sequence=0;this.calls=[];}
 object(value){const id=createHash("sha1").update(JSON.stringify([++this.sequence,value])).digest("hex");this.objects.set(id,structuredClone(value));return id;}
 async request(method,path,body){
  this.calls.push({method,path,body});
  const p=path.slice(ROOT.length),notFound=()=>{throw Object.assign(Error("Not found"),{status:404});};
  if(method==="GET"&&p.startsWith("/git/ref/heads/")){const sha=this.refs.get(p.slice(15));if(!sha)return notFound();return {object:{sha}};}
  if(method==="GET"&&p.startsWith("/contents/")){
   const u=new URL("https://example.invalid"+p),commit=this.objects.get(u.searchParams.get("ref"));
   const file=u.pathname.slice(10),tree=commit&&this.objects.get(commit.tree),entry=tree?.tree.find(x=>x.path===file),blob=entry&&this.objects.get(entry.sha);
   return blob?{type:"file",encoding:"base64",content:blob.content}:notFound();
  }
  if(method==="POST"&&["/git/blobs","/git/trees","/git/commits"].includes(p))return {sha:this.object(body)};
  if(method==="POST"&&p==="/git/refs"){
   const name=body.ref.slice(11);if(this.refs.has(name))throw Object.assign(Error("Conflict"),{status:422});this.refs.set(name,body.sha);return {object:{sha:body.sha}};
  }
  if(method==="PATCH"&&p.startsWith("/git/refs/heads/")){
   const name=p.slice(16),current=this.refs.get(name),next=this.objects.get(body.sha);
   if(body.force!==false||!current||!next?.parents.includes(current))throw Object.assign(Error("CAS conflict"),{status:422});this.refs.set(name,body.sha);return {object:{sha:body.sha}};
  }
  throw Error("Unexpected metadata route "+method+" "+p);
 }
}
module.exports={MetadataFixture};
