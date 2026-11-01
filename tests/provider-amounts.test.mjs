import test from 'node:test';
import assert from 'node:assert/strict';
import {providerUnits,providerNetReward} from '../public/provider-amounts.mjs';
import {units,normalizePackage} from '../public/core.mjs';
test('API monetary values normalize exponent notation, padded decimals and wrappers without float conversion',()=>{
 for(const value of ['0E-8','0.000000000000000000',0,'-0E-200','0E-2147483647'])assert.equal(providerUnits(value),0);
 for(const value of ['1e-4','1.000000000000E-4','  +0.000100000000000  ',{value:'1E-4'},{amount:'0.0001000000'},{amount:{value:'1E-4'}},.0001])assert.equal(providerUnits(value),10000);
 assert.equal(providerUnits('1e-8'),1);assert.equal(providerUnits('1.23456789E+2'),12345678900);
 assert.equal(providerUnits('90071992.54740991'),Number.MAX_SAFE_INTEGER);
 assert.throws(()=>units('1E-4'));assert.throws(()=>units('0.0001000000000'));
});
test('invalid or missing API costs never turn into zero or a rounded-down debit',()=>{
 for(const value of [null,undefined,'',false,[],{},'NaN',Infinity,'1,000','0.000000001','-0.0001','90071992.54740992','1E999999']){
  assert.throws(()=>providerUnits(value,'team member addedAmount'),e=>e.code==='NICEHASH_AMOUNT_ERROR'&&e.field==='team member addedAmount'&&e.message.includes('team member addedAmount'));
 }
});
test('team rewards subtract full precision fees before flooring cumulative net once',()=>{
 assert.deepEqual(providerNetReward('2.1E-8','9E-9'),{amount:1,rounded:true});
 assert.deepEqual(providerNetReward('1.2345678999','0.0000000099'),{amount:123456789,rounded:false});
 assert.deepEqual(providerNetReward({value:'0E-8'},{amount:'0E-8'}),{amount:0,rounded:false});
 assert.throws(()=>providerNetReward(null,0,'team BTC reward'),/rewardAmount/);
 assert.throws(()=>providerNetReward('1E-8','2E-8'),/fee exceeds/);
});
test('catalogue amounts use provider parsing while settings decimals stay strict',()=>{
 const p=normalizePackage({id:'team',status:'WAITING',addedAmount:'6E-3',minShareAmount:'0.0001000000',currencyAlgoTicket:{name:'Team Gold',currencyMarket:'BTC',currencyAlgo:{currency:'BTC'}}},new Date().toISOString(),true);
 assert.equal(p.costBtc,10000);assert.equal(p.minShare,10000);assert.equal(p.teamShares,60);
});
