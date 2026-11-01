// Provider decimals are not form inputs: Java BigDecimal responses may use
// exponent notation, padded fractional zeros, or {value}/{amount} wrappers.
// Keep all decimal arithmetic in BigInt until the final safe ledger integer.
const MAX=BigInt(Number.MAX_SAFE_INTEGER);
function fail(field,reason){throw Object.assign(new Error('NiceHash '+field+': '+reason),{code:'NICEHASH_AMOUNT_ERROR',field});}
function decimalParts(value,field){
  for(let depth=0;value&&typeof value==='object'&&!Array.isArray(value)&&depth<3;depth++){
    if(Object.hasOwn(value,'value'))value=value.value;
    else if(Object.hasOwn(value,'amount'))value=value.amount;
    else break;
  }
  if((typeof value!=='string'&&typeof value!=='number')||(typeof value==='number'&&!Number.isFinite(value)))fail(field,'missing or invalid decimal amount');
  const text=String(value).trim();
  if(text.length>512)fail(field,'decimal amount is too large');
  const m=/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if(!m)fail(field,'invalid decimal amount');
  const fraction=m[3]??m[4]??'',digits=(m[2]||'0')+fraction,coefficient=BigInt(digits)*(m[1]==='-'?-1n:1n);
  if(coefficient===0n)return {coefficient:0n,scale:0};
  const exponent=Number(m[5]||0);
  if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>1000)fail(field,'decimal exponent is outside the supported range');
  return {coefficient,scale:fraction.length-exponent};
}
function integerUnits({coefficient,scale},field,{rounding='exact'}={}){
  if(coefficient<0n)fail(field,'amount must be nonnegative');
  const shift=8-scale;let amount,remainder=0n;
  if(shift>=0)amount=coefficient*10n**BigInt(shift);
  else{
    const divisor=10n**BigInt(-shift);amount=coefficient/divisor;remainder=coefficient%divisor;
    if(remainder&&rounding==='exact')fail(field,'nonzero precision below one 0.00000001 ledger unit; amount was not rounded');
  }
  if(amount>MAX)fail(field,'amount exceeds safe ledger precision');
  return {amount:Number(amount),rounded:remainder!==0n};
}
export function providerUnits(value,field='amount'){
  return integerUnits(decimalParts(value,field),field).amount;
}
export function providerNetReward(gross,fee,field='team reward'){
  const g=decimalParts(gross,field+'.rewardAmount'),f=decimalParts(fee,field+'.rewardFeeAmount');
  if(g.coefficient<0n||f.coefficient<0n)fail(field,'reward and fee must be nonnegative');
  const scale=Math.max(g.scale,f.scale),coefficient=g.coefficient*10n**BigInt(scale-g.scale)-f.coefficient*10n**BigInt(scale-f.scale);
  if(coefficient<0n)fail(field,'reward fee exceeds the reward amount');
  // Team allocation fractions can be smaller than the coin's payable unit.
  // Subtract fees exactly, then floor the cumulative net once, never each part.
  return integerUnits({coefficient,scale},field,{rounding:'floor'});
}
export function providerSumUnits(values,field='provider amounts'){
  const parts=values.map((value,index)=>decimalParts(value,field+'['+index+']'));
  if(parts.some(p=>p.coefficient<0n))fail(field,'amounts must be nonnegative');
  const scale=Math.max(0,...parts.map(p=>p.scale));
  const coefficient=parts.reduce((sum,p)=>sum+p.coefficient*10n**BigInt(scale-p.scale),0n);
  return integerUnits({coefficient,scale},field,{rounding:'floor'});
}
