import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export const NICEHASH_BASE='https://api2.nicehash.com';
export function configValue(value,label,env=process.env){
  let text=String(value??'').replace(/[\u200B-\u200D\uFEFF]/g,'').trim();
  if((text.startsWith('"')&&text.endsWith('"'))||(text.startsWith("'")&&text.endsWith("'")))text=text.slice(1,-1).trim();
  text=text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(_,name)=>{
    if(!name.startsWith('NICEHASH_'))throw new Error(label+': use a NICEHASH_ environment variable');
    if(!env[name]?.trim())throw new Error(name+' is not set in the server environment');
    return String(env[name]).trim();
  });
  if(text.includes('${'))throw new Error(label+': unresolved environment placeholder');
  return text;
}
export function baseUrl(value,env=process.env){
  const text=configValue(value||NICEHASH_BASE,'NiceHash base URL',env);
  let url;try{url=new URL(text);}catch{throw new Error('Use a valid NiceHash API base URL');}
  if(url.protocol!=='https:'||!['api2.nicehash.com','api-test.nicehash.com'].includes(url.hostname)||url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Base URL must be https://api2.nicehash.com or https://api-test.nicehash.com');
  return url.origin;
}
export function normalizeCredentials(input,env=process.env){
  const raw=input?.nicehash||input||{};
  const c={key:configValue(raw.api_key??raw.key,'API key',env),secret:configValue(raw.api_secret??raw.secret,'API secret',env),
    orgId:configValue(raw.organization_id??raw.orgId,'Organization ID',env).toLowerCase(),baseUrl:baseUrl(raw.base_url??raw.baseUrl,env)};
  if(!c.key||!c.secret||!c.orgId)throw new Error('Provide organization ID, API key and API secret');
  if(!/^[a-f0-9-]{36}$/i.test(c.orgId))throw new Error('Organization ID must be the UUID from NiceHash API Keys settings');
  if(/\s/.test(c.key)||/\s/.test(c.secret))throw new Error('API key or secret contains whitespace; copy the complete value again');
  return c;
}
export function loadServerConfig({env=process.env,root=process.cwd()}={}){
  try{
    const configuredPath=env.NICEHASH_CONFIG_FILE;
    const file=resolve(root,configuredPath||'config.json');
    let raw;
    if(configuredPath||existsSync(file)){
      let data;try{data=JSON.parse(readFileSync(file,'utf8'));}catch{throw new Error('Cannot read NiceHash configuration JSON; check NICEHASH_CONFIG_FILE and its JSON syntax');}
      raw=data.nicehash;if(!raw)throw new Error('Configuration JSON must contain a nicehash object');
    }else{
      if(![env.NICEHASH_API_KEY,env.NICEHASH_API_SECRET,env.NICEHASH_ORGANIZATION_ID,env.NICEHASH_ORG_ID].some(v=>v?.trim()))return {credentials:null,error:null,source:null};
      raw={api_key:env.NICEHASH_API_KEY,api_secret:env.NICEHASH_API_SECRET,organization_id:env.NICEHASH_ORGANIZATION_ID||env.NICEHASH_ORG_ID,base_url:env.NICEHASH_BASE_URL};
    }
    return {credentials:normalizeCredentials(raw,env),error:null,source:configuredPath||existsSync(file)?'config.json':'environment'};
  }catch(e){return {credentials:null,error:e.message,source:null};}
}
