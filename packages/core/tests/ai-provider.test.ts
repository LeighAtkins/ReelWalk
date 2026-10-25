import { afterEach, test, vi } from 'vitest';
// The workspace AI switch has its own tests (apps/web/lib/ai-off.test.ts); here every workspace has AI on.
vi.mock('../../../apps/web/lib/ai-gate', () => ({ assertAiOn: async () => undefined }));
import assert from 'node:assert/strict';
import { structuredAnswer, aiModel, isAiConfigured, usageCostUsd } from '../../../apps/web/lib/openai';
import { AI_EDIT_PLAN_JSON_SCHEMA, DIRECTOR_PLAN_JSON_SCHEMA, aiEditPlanSchema, directorPlanSchema, applyAiEditPlan, emptyTimeline, clipSchema } from '../src';
const env={...process.env};const originalFetch=globalThis.fetch;
afterEach(()=>{process.env={...env};globalThis.fetch=originalFetch;});
const options={workspaceId:'ws1',instructions:'Edit this reel safely.',input:'Keep natural speed.',schemaName:'reel_edit_plan',schema:AI_EDIT_PLAN_JSON_SCHEMA as unknown as Record<string,unknown>};
function claude(){process.env.AI_PROVIDER='anthropic';process.env.ANTHROPIC_API_KEY='test-only';delete process.env.ANTHROPIC_MODEL;}
test('Claude sends strict edit schema and applies a validated plan through the existing editor',async()=>{
 claude();const blank=Object.fromEntries(AI_EDIT_PLAN_JSON_SCHEMA.properties.ops.items.required.map(k=>[k,null]));const plan={ops:[{...blank,op:'speed',clip:1,speed:1}],note:'Natural speed preserved.',questions:[],caption:null};
 globalThis.fetch=async(url,init)=>{assert.equal(url,'https://api.anthropic.com/v1/messages');const body=JSON.parse(init!.body as string);assert.equal(body.model,'claude-opus-5-5');assert.deepEqual(body.output_config.format.schema.properties.ops.items.required,["op","arguments"]);assert.ok(body.system.startsWith(options.instructions));assert.equal((init!.headers as Record<string,string>)['x-api-key'],'test-only');assert.equal(body.max_tokens,4096);return Response.json({model:body.model,stop_reason:'end_turn',content:[{type:'thinking',thinking:'private'},{type:'text',text:JSON.stringify({...plan,ops:[{op:"speed",arguments:JSON.stringify({clip:1,speed:1})}]})}],usage:{input_tokens:100,output_tokens:80,cache_read_input_tokens:20,cache_creation_input_tokens:10}});};
 const answer=await structuredAnswer(options);assert.equal(answer.model,'claude-opus-5-5');assert.deepEqual(aiEditPlanSchema.parse(answer.json),plan);assert.equal(answer.usage.inputTokens,130);assert.equal(answer.usage.cachedTokens,20);assert.equal(answer.usage.cacheWriteTokens,10);const timeline={...emptyTimeline(),clips:[clipSchema.parse({id:'clip',assetId:'video',kind:'VIDEO',sourceStartMs:0,sourceEndMs:6000,speed:3})]};const applied=applyAiEditPlan(timeline,aiEditPlanSchema.parse(answer.json),{assets:{video:{id:'video',kind:'VIDEO',title:'Pan',durationMs:10000,isPano:false,bpm:null,beatOffsetMs:null}},songs:[]});assert.equal(applied.timeline.clips[0].speed,1);assert.equal(applied.timeline.clips[0].sourceEndMs,6000);assert.equal(applied.skipped.length,0);assert.ok(Math.abs(usageCostUsd(answer.model,answer.usage)-.002054)<1e-9);
});
test('explicit Claude selection does not fall back to an available OpenAI key',async()=>{claude();delete process.env.ANTHROPIC_API_KEY;process.env.OPENAI_API_KEY='other-test';assert.equal(isAiConfigured(),false);let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not call')};await assert.rejects(structuredAnswer(options),/not configured/);assert.equal(calls,0);});
test('SSM unset placeholder does not activate Claude',()=>{claude();process.env.ANTHROPIC_API_KEY='unset';assert.equal(isAiConfigured(),false);});
test('Claude vision carries image data without remote image fetches',async()=>{claude();globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init!.body as string);assert.deepEqual(body.messages[0].content[1],{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'YWJj'}});return Response.json({stop_reason:'end_turn',content:[{type:'text',text:'{}'}]});};await structuredAnswer({...options,schemaName:'room_labels',images:['data:image/jpeg;base64,YWJj']});await assert.rejects(structuredAnswer({...options,images:['https://example.com/private.jpg']}),/image data URL/);});
test('refusal, truncation, malformed JSON and provider errors never become applied edits',async()=>{claude();for(const data of [{stop_reason:'refusal'},{stop_reason:'max_tokens',content:[{type:'text',text:'{}'}]},{stop_reason:'end_turn',content:[{type:'text',text:'not json'}]}]){globalThis.fetch=async()=>Response.json(data);await assert.rejects(structuredAnswer(options));}globalThis.fetch=async()=>Response.json({error:{message:'secret request'}},{status:401});await assert.rejects(structuredAnswer(options),e=>e instanceof Error&&e.message.includes('401')&&!e.message.includes('secret'));});
test('explicit OpenAI rollback keeps the existing transport',async()=>{process.env.AI_PROVIDER='openai';process.env.OPENAI_API_KEY='test-only';process.env.ANTHROPIC_API_KEY='also-configured';delete process.env.OPENAI_BASE_URL;delete process.env.OPENAI_MODEL;assert.equal(aiModel(),'gpt-6-luna');globalThis.fetch=async(url)=>{assert.equal(url,'https://api.openai.com/v1/responses');return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]});};assert.deepEqual((await structuredAnswer(options)).json,{});});

// Claude rejected the director schema with HTTP 400 ("Enum value 0.5 does not match declared type") because
// the nested edit plan skipped the transport encoding that plain edits use.
test('director reviews send the edit plan in Claude transport form and decode it back',async()=>{
 claude();
 const numericEnums=(node:unknown):string[]=>{if(!node||typeof node!=='object')return[];const o=node as Record<string,unknown>;const here=Array.isArray(o.enum)&&o.enum.some(v=>typeof v==='number'&&!Number.isInteger(v))?[JSON.stringify(o.enum)]:[];return[...here,...Object.values(o).flatMap(numericEnums)];};
 assert.ok(numericEnums(DIRECTOR_PLAN_JSON_SCHEMA).length>0,'the raw schema carries the fractional enum Claude refuses');
 const blank=Object.fromEntries(AI_EDIT_PLAN_JSON_SCHEMA.properties.ops.items.required.map(k=>[k,null]));
 const check={result:'pass',evidence:'Sampled frames show consistent scale.'};
 const review={note:'Tighten the opening.',verdict:'changes-proposed',issues:[],limitations:'Stills only.',checks:{scale:check,cameraContinuity:check,presenterContinuity:check,propertyIdentity:check},shots:[]};
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init!.body as string);const sent=body.output_config.format.schema;
  assert.deepEqual(numericEnums(sent),[]);assert.deepEqual(sent.properties.edit.properties.ops.items.required,['op','arguments']);assert.match(body.system,/edit object uses this transport/);
  return Response.json({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({...review,edit:{ops:[{op:'speed',arguments:JSON.stringify({clip:1,speed:1})}],note:'Natural speed.',questions:[],caption:null}})}]});};
 const answer=await structuredAnswer({workspaceId:'ws1',instructions:'Direct this reel.',input:'Review it.',schemaName:'opus_director',schema:DIRECTOR_PLAN_JSON_SCHEMA as unknown as Record<string,unknown>});
 const plan=directorPlanSchema.parse(answer.json);
 assert.deepEqual(plan.edit.ops,[{...blank,op:'speed',clip:1,speed:1}]);
});
