export function errorResponse(error){
  if(error?.code==='NICEHASH_API_ERROR')return {status:502,body:{error:error.message,code:error.code,provider:{name:'NiceHash',httpStatus:error.upstreamStatus||0,
    code:error.nicehashCode??null,message:error.providerMessage||null,method:error.method||null,path:error.path||null,requestId:error.requestId||null,clockOffsetMs:error.clockOffsetMs??null}}};
  const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:400;
  return {status,body:{error:error?.message||'Request failed',code:'APP_REQUEST_ERROR'}};
}
