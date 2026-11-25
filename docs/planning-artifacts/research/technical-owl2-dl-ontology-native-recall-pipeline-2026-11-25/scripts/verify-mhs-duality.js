// d4 §8.2.1 自验脚本：MUS/MCS 与极小解释族的对偶关系（可在本机直接跑：node verify_mhs.js）
// 用法：node verify_mhs.js   → 输出 total / C1..C4 四个计数器
// 结论：C1 (MCS == MHS(minF)) 与 C2 (minF == MHS(MCS)) 在 600/600 成立；
//       C3 (minF == MHS(max(2^A\F))) 只约四成成立 —— 这个常见写法是错的；C4 恒为 0。
// 随机序列由固定种子决定（seed=20261125），重跑可复现。
function subsets(A){ let r=[[]]; for(const x of A){ r = r.concat(r.map(s=>s.concat([x]))); } return r; }
function key(s){ return s.slice().sort().join(','); }
function isSubset(a,b){ return a.every(x=>b.includes(x)); }
function eqFam(X,Y){ if(X.length!==Y.length) return false; const ys=new Set(Y.map(key)); return X.every(x=>ys.has(key(x))); }
function minimal(F){ return F.filter(x => !F.some(y=> key(y)!==key(x) && isSubset(y,x)) ); }
function maximal(F){ return F.filter(x => !F.some(y=> key(y)!==key(x) && isSubset(x,y)) ); }
function MHS(S){ if(S.length===0) return [[]]; const U=[...new Set(S.flat())]; const all=subsets(U); const hit=all.filter(h=>S.every(s=>h.some(x=>s.includes(x)))); return minimal(hit); }
let seed=20261125;
function rnd(){ seed = (seed*1103515245+12345) % 2147483647; return seed/2147483647; }
const res={C1:0,C2:0,C3:0,C4:0,total:0};
const exC3=[];
for(let t=0;t<600;t++){
  const n = 3 + (t%2);
  const A = 'abcdefgh'.slice(0,n).split('');
  const all = subsets(A);
  const cand=[];
  const pick = 1+Math.floor(rnd()*all.length);
  for(let i=0;i<pick;i++) cand.push(all[Math.floor(rnd()*all.length)]);
  let minF = minimal(cand.filter((s,i,arr)=>arr.findIndex(z=>key(z)===key(s))===i));
  if(minF.length===0) minF=[[]];
  const inF = s => minF.some(m=>isSubset(m,s));
  const comp = all.filter(s=>!inF(s));
  const mcsCand = all.filter(D=>!inF(A.filter(x=>!D.includes(x))));
  const MCS = minimal(mcsCand);
  res.total++;
  if(eqFam(MCS, MHS(minF))) res.C1++;
  if(eqFam(minF, MHS(MCS))) res.C2++;
  const wrong = MHS(maximal(comp));
  if(eqFam(minF, wrong)) res.C3++; else if(exC3.length<3) exC3.push({A:A.join(''),minF:minF.map(key),wrong:wrong.map(key)});
  if(eqFam(MCS, wrong)) res.C4++;
}
console.log('total='+res.total);
console.log('C1 MCS==MHS(minF): '+res.C1);
console.log('C2 minF==MHS(MCS): '+res.C2);
console.log('C3 minF==MHS(max(comp)): '+res.C3);
console.log('C4 MCS==MHS(max(comp)): '+res.C4);
console.log('ex='+JSON.stringify(exC3));
