import assert from 'node:assert/strict';
import {repeatedDiscussionAnswer as select} from '../../src/chaoxing/discussion-consensus.mjs';
const post=(id,text,extra={})=>({id,authorId:id,text,...extra});
const answer='导数描述函数在某一点的瞬时变化率，可以用来分析函数的变化趋势。';
let result=select([post('a',answer),post('b',answer.replace('某一点','一点')),post('c','学习时应当结合图形理解概念，并通过练习巩固知识。',{likes:999,replies:999})]);
assert.equal(result.found,true);assert.equal(result.matches,2);assert.ok([answer,answer.replace('某一点','一点')].includes(result.text),'复制已有原文，不拼接新答案');
assert.equal(select([post('a',answer),post('a',answer),post('b',answer,{authorId:'a'})]).found,false,'同一人重复发言不算多人共识');
assert.equal(select([post('a','同意'),post('b','同意')]).found,false,'忽略打卡与空泛评论');
assert.equal(select([post('a','不一定'),post('b','不一定')]).matches,2,'有实际含义的简短重复回答也能选取');
for(const [a,b]of [
 ['这个函数在区间内单调递增，因此可以用端点值比较函数值。','这个函数在区间内单调递减，因此可以用端点值比较函数值。'],
 ['当 x=1 时函数在该点满足连续条件，所以可以继续判断。','当 x=-1 时函数在该点满足连续条件，所以可以继续判断。'],
 ['函数在该点连续，所以可以直接使用这个条件进行分析。','函数在该点不连续，所以可以直接使用这个条件进行分析。'],
 ['只有满足 a>b 时才能使用这个结论，其他情况需要另行判断。','只有满足 a<b 时才能使用这个结论，其他情况需要另行判断。'],
 ['参数增加时函数值也会逐渐增大，需要结合定义进行分析。','参数增加时函数值也会逐渐减小，需要结合定义进行分析。'],
])assert.equal(select([post('a',a),post('b',b)]).found,false,'数学含义不同不能因相似而合并');
result=select([post('a',answer,{isSelf:true}),post('b',answer)]);assert.equal(result.found,false);
assert.equal(select([post('a',answer),post('b',answer.replace('，','，  '))]).matches,2);
console.log('✓ 重复回答优先：近似聚类、原文代表、独立作者、忽略点赞、数学数值/符号/否定含义隔离通过');
