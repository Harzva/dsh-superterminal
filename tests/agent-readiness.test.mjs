import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentReadiness, loginEvidence, readinessSnapshot } from '../src/agent-readiness.mjs'

test('login evidence never persists account identifiers or implies online connection', () => {
  const codex = loginEvidence('codex', {exitCode:0}, '', 'Logged in using API key - sample-secret-fragment', 100)
  assert.equal(codex.state, 'verified');assert.equal(codex.checkedAt,100)
  assert.doesNotMatch(JSON.stringify(codex), /sample-secret/)
  assert.equal(loginEvidence('codex',{exitCode:0},'unexpected help output').state,'unknown')
  assert.equal(loginEvidence('codex',{exitCode:1},'','Not logged in').state,'missing')
  const claude = loginEvidence('claude',{exitCode:0},JSON.stringify({loggedIn:true,email:'private@example.invalid',accessToken:'sample-secret'}))
  assert.equal(claude.state,'verified');assert.doesNotMatch(JSON.stringify(claude),/private@|sample-secret/)
  assert.equal(loginEvidence('claude',{exitCode:0},'{"loggedIn":false}').state,'missing')
  assert.equal(loginEvidence('claude',{exitCode:1},'{"loggedIn":true}').state,'unknown')
  const snapshot=readinessSnapshot('codex',true,{auth:codex,checkedAt:150})
  assert.equal(snapshot.connection.state,'unknown');assert.equal(snapshot.quota.state,'unknown')
})

test('model evidence uses actual execution time, never review time or unrelated agents', () => {
  const tasks=[{targetLauncher:'pi',status:'succeeded',executionFinishedAt:120,updatedAt:9999},
    {targetLauncher:'codex',status:'succeeded',executionFinishedAt:800,updatedAt:900}]
  const pi=readinessSnapshot('pi',true,{tasks,checkedAt:10000})
  assert.equal(pi.connection.state,'last_succeeded');assert.equal(pi.connection.checkedAt,120)
  assert.equal(pi.quota.state,'unknown')
  assert.equal(readinessSnapshot('claude',true,{tasks}).connection.state,'unknown')
  assert.equal(readinessSnapshot('pi',true,{tasks:[{targetLauncher:'pi',status:'succeeded',updatedAt:9999}]}).connection.state,'unknown')
  const quota=readinessSnapshot('pi',true,{tasks:[{targetLauncher:'pi',status:'failed',executionFinishedAt:200,error:'Pi 报告额度或订阅限制'}]})
  assert.equal(quota.quota.state,'limited');assert.equal(quota.quota.checkedAt,200)
  const newerAuth=loginEvidence('codex',{exitCode:1},'Not logged in','',1000)
  assert.equal(readinessSnapshot('codex',true,{tasks,auth:newerAuth}).authentication.state,'missing')
  const generic=readinessSnapshot('pi',true,{tasks:[{targetLauncher:'pi',status:'failed',executionFinishedAt:200,error:'智能体未正常返回，请检查连接状态或任务错误'}]})
  assert.equal(generic.connection.state,'unknown')
})

function fixture({hung=false,cleanup=true}={}) {
  const handles=[], owner={id:'a',session:{events:[]}}, active=new Set([owner])
  const ctx={sandboxPolicy:{resolve:()=>({mode:'workspace-write',workspaceRoot:'/workspace'})},get:()=>({confine:argv=>({argv:['sandbox',...argv]})}),subprocess:{
    resolveExecutable:async name=>'/bin/'+name,
    spawn(spec) {
      const deferred=Promise.withResolvers()
      const handle={spec,done:hung?deferred.promise:Promise.resolve({exitCode:1}),collected:{stdout:{readFrom:()=>({text:''})},stderr:{readFrom:()=>({text:'Not logged in'})}},
        terminate(){handle.terminated=true;deferred.resolve({exitCode:1})},waitForExit:async()=>cleanup}
      handles.push(handle);return handle
    }
  }}
  const terminals={ctx,current(value){if(!active.has(value))throw new Error('owner invalid')},owned(value){this.current(value)}}
  return {service:new AgentReadiness(terminals),owner,handles,active}
}

test('workspace login checks use the same confinement, redact output, and isolate owners',async()=>{
  const f=fixture();const result=await f.service.check(f.owner,'codex')
  assert.equal(result.authentication.state,'missing');assert.equal(f.handles.length,1)
  assert.equal(f.handles[0].spec.argv[0],'sandbox')
  assert.equal(f.handles[0].spec.env.CODEX_HOME,'/workspace/.dsh-terminal/codex')
  assert.equal(f.handles[0].spec.cwd,'/workspace');assert.equal(f.handles[0].terminated,true)
  assert.equal(f.service.hasActive(f.owner),false)
  const other={...f.owner};f.active.add(other)
  assert.equal(f.service.auth(other,'codex'),undefined)
  f.active.delete(f.owner);await assert.rejects(f.service.check(f.owner,'codex'),/owner invalid/)
  await f.service.disposeOwner(f.owner)
})

test('concurrent login checks dedupe and timeout drains subprocesses',async()=>{
  const f=fixture({hung:true});f.service.timeoutMs=5
  const [a,b]=await Promise.all([f.service.check(f.owner,'codex'),f.service.check(f.owner,'codex')])
  assert.equal(f.handles.length,1);assert.deepEqual(a,b);assert.equal(a.authentication.state,'unknown')
  assert.equal(f.handles[0].terminated,true);assert.equal(f.service.hasActive(f.owner),false)
})

test('incomplete cleanup remains fenced instead of reporting a clean check',async()=>{
  const f=fixture({cleanup:false});const result=await f.service.check(f.owner,'codex')
  assert.equal(result.authentication.state,'unknown');assert.equal(f.service.hasActive(f.owner),true)
  await assert.rejects(f.service.check(f.owner,'codex'),/cleanup incomplete/)
  assert.equal(f.handles.length,1)
})
