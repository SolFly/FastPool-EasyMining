export const levelSummary=s=>s.teamLevels?.length?s.teamLevels.map(l=>l.threshold+' → +'+l.shares).join(' · '):'';
export function bindTeamLevels(form,strategy){
  const host=form.querySelector('#team-level-editor');
  let rows=(strategy.teamLevels?.length?strategy.teamLevels:[{threshold:50,shares:1},{threshold:100,shares:1},{threshold:150,shares:1}]).map(l=>({...l}));
  host.innerHTML=`<label class="check-field"><input type="checkbox" id="use-team-levels" ${strategy.teamLevels?.length?'checked':''}>Buy additional shares at multiple team levels</label><small>Thresholds use the total joined shares in each team, including your own. Each level buys an additional quantity once per team. Your minimum buying interval and all spending limits still apply.</small><div id="team-level-rows"></div><div class="level-actions"><button type="button" class="btn small" id="add-team-level">Add level</button><button type="button" class="btn small" id="team-level-example">Use 50 / 100 / 150 example · 1 minute</button></div><small>Entries already bought by this strategy count as the first level. Manual entries and teams owned by other strategies are not modified. Reached levels run one at a time; saved progress survives restarts and settings imports.</small>`;
  const enabled=host.querySelector('#use-team-levels'),list=host.querySelector('#team-level-rows'),mode=form.querySelector('#strategy-mode');
  const read=()=>Array.from(list.querySelectorAll('[data-level-row]')).map(row=>({threshold:Number(row.querySelector('[data-threshold]').value),shares:Number(row.querySelector('[data-shares]').value)}));
  const render=()=>{list.innerHTML=rows.map((l,i)=>`<div class="team-level-row" data-level-row><div><label for="level-threshold-${i}">Level ${i+1} · joined shares ≥</label><input id="level-threshold-${i}" data-threshold type="number" min="0" max="100000" step="1" value="${Number(l.threshold)}" required></div><div><label for="level-shares-${i}">Buy additional shares</label><input id="level-shares-${i}" data-shares type="number" min="1" max="100" step="1" value="${Number(l.shares)}" required></div><button type="button" class="btn small" data-remove-level="${i}" ${rows.length===1?'disabled':''} aria-label="Remove buying level ${i+1}">Remove</button></div>`).join('');update();};
  const update=()=>{host.hidden=mode.value!=='team';if(host.hidden)enabled.checked=false;list.hidden=!enabled.checked;host.querySelector('.level-actions').hidden=!enabled.checked;
    for(const input of list.querySelectorAll('input'))input.disabled=!enabled.checked;
    for(const name of ['shares','minTeamShares'])form.querySelector('#'+name).closest('.field').hidden=enabled.checked;
  };
  enabled.addEventListener('change',update);mode.addEventListener('change',update);
  form.querySelector('#kind').addEventListener('change',()=>{if(form.querySelector('#kind').value==='team'){mode.value='team';update();}});
  list.addEventListener('click',event=>{const button=event.target.closest('[data-remove-level]');if(!button)return;rows=read();rows.splice(Number(button.dataset.removeLevel),1);render();});
  host.querySelector('#add-team-level').addEventListener('click',()=>{rows=read();if(rows.length>=20)return;rows.push({threshold:(rows.at(-1)?.threshold||0)+50,shares:1});render();});
  host.querySelector('#team-level-example').addEventListener('click',()=>{rows=[{threshold:50,shares:1},{threshold:100,shares:1},{threshold:150,shares:1}];form.querySelector('#intervalMinutes').value='1';render();});
  render();return ()=>enabled.checked?read():[];
}
