export function createHttpClient({fetcher=fetch,onAuthRequired=()=>{}}={}){
  return async function request(path,method='GET',body){
    const response=await fetcher(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    let data;try{data=await response.json();}catch{throw new Error('Server returned an unexpected response');}
    // Only our own session-expiry marker can change the dashboard login state.
    if(response.status===401&&data.code==='AUTH_REQUIRED'){onAuthRequired();throw new Error('Please sign in');}
    if(!response.ok){const error=new Error(data.error||'Request failed');error.code=data.code;error.provider=data.provider;error.warnings=data.warnings;throw error;}
    return data;
  };
}
