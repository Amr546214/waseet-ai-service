import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { GeminiGateway, paidFixture } from "../helpers/ai-fixtures.js";
import { ContentInspector } from "../../src/core/security/content-inspector.js";
import { AccreditationService } from "../../src/features/providers/accreditation.service.js";
import { DurableStore } from "../../src/core/database/durable-store.js";
const inline=(body: Buffer|string,mime='application/octet-stream')=>`data:${mime};base64,${Buffer.from(body).toString('base64')}`;
beforeEach(()=>paidFixture());
after(()=>{GeminiGateway.setMockHandler(null);DurableStore.close();});

test('unsupported binary metadata never becomes read content or an inspected result',async()=>{
  const bytes=Buffer.from([0x89,0x50,0x4e,0x47,0,1,2,3]);
  const result=await ContentInspector.inspect([inline(bytes,'image/png')]);
  assert.equal(result.inspected,false);assert.equal(result.basis,'CONTENT_NOT_INSPECTED');
  assert.equal(result.evidence.length,1);assert.equal(result.evidence[0]!.contentRead,false);
  assert.equal(result.evidence[0]!.excerpt,'');assert.equal(result.evidence[0]!.lineCount,0);
  assert.equal(result.evidence[0]!.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.ok(result.unavailable.some(x=>x.startsWith('CONTENT_NOT_READABLE:uploaded-file://inline/1')));
  assert.ok(!JSON.stringify(result).includes('data:'));
});
test('actual extracted text, DOCX and archive content still count as readable evidence',async()=>{
  const docx=Buffer.from(zipSync({'word/document.xml':strToU8('<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Actual document evidence</w:t></w:r></w:p></w:body></w:document>')}));
  const zip=Buffer.from(zipSync({'source.ts':strToU8('export const count = 1;')}));
  const result=await ContentInspector.inspect([inline('Actual text evidence','text/plain'),inline(docx,'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),inline(zip,'application/zip')]);
  assert.equal(result.inspected,true);assert.equal(result.unavailable.length,0);
  assert.match(result.evidence[0]!.excerpt,/Actual text evidence/);assert.equal(result.evidence[0]!.source,'uploaded-file://inline/1');
  assert.match(result.evidence[1]!.excerpt,/Actual document evidence/);assert.equal(result.evidence[1]!.basis,'DOCX_TEXT_EXTRACTION');
  assert.match(result.evidence[2]!.excerpt,/export const count/);assert.match(result.evidence[2]!.source,/inline\/3#source.ts/);
});
test('malformed, empty, corrupt PDF and oversized payloads have explicit failures, never fabricated evidence',async()=>{
  for(const raw of ['data:application/pdf;base64,%%%%','data:application/pdf;base64,','data:application/pdf;base64', 'data:text/plain,%zz',inline('not a PDF','application/pdf'),inline(Buffer.alloc(512*1024+1,65),'text/plain')]){
    const result=await ContentInspector.inspect([raw]);assert.equal(result.inspected,false);
    assert.equal(result.evidence.length,0);assert.equal(result.unavailable.length,1);
    assert.ok(!JSON.stringify(result).includes(raw));
  }
});
test('mixed inputs preserve unreadable status per file and use distinct opaque sources',async()=>{
  const result=await ContentInspector.inspect([inline('Readable text','text/plain'),inline(Buffer.from([0,2,3]),'application/octet-stream')]);
  assert.equal(result.inspected,true);assert.deepEqual(result.evidence.map(e=>e.contentRead),[true,false]);
  assert.notEqual(result.evidence[0]!.source,result.evidence[1]!.source);assert.equal(result.unavailable.length,1);
});
test('percent-encoded text works; oversize percent-encoded bytes are rejected before extraction',async()=>{
  const text=await ContentInspector.inspect(['data:text/plain;charset=utf-8,'+encodeURIComponent('دليل حقيقي')]);
  assert.equal(text.inspected,true);assert.equal(text.evidence[0]!.excerpt,'دليل حقيقي');
  const big=await ContentInspector.inspect(['data:text/plain,'+'%41'.repeat(512*1024+1)]);
  assert.equal(big.inspected,false);assert.match(big.unavailable[0]!,/^CONTENT_TOO_LARGE:/);
});
test('unreadable accreditation stays UNVERIFIED with null quality and no model call',async()=>{
  let calls=0;GeminiGateway.setMockHandler(async()=>{calls++;throw new Error('must not review unreadable bytes');});
  try{
    const result=await AccreditationService.evaluateAccreditation('sample','ملف مقدم',inline(Buffer.from([0,1,2]),'image/png'));
    assert.equal(result.inspected,false);assert.equal(result.sample.status,'UNVERIFIED');assert.equal(result.evaluation.aiScore,null);assert.equal(result.evaluation.aiQualityRating,null);assert.match(result.evaluation.feedbackAr,/تعذّر قراءة محتواه/);assert.equal(calls,0);
  }finally{GeminiGateway.setMockHandler(null);}
});
test('an aborted inspection remains a cancellation rather than a successful metadata-only read',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>ContentInspector.inspect([inline('text','text/plain')],controller.signal),{code:'CANCELLED'});
});


test('a file exactly at the byte limit is parsed without regex overflow and marked as partial text',async()=>{
  const result=await ContentInspector.inspect([inline(Buffer.alloc(512*1024,65),'text/plain')]);
  assert.equal(result.inspected,true);assert.equal(result.evidence[0]!.truncated,true);
  assert.equal(result.evidence[0]!.excerpt.length,24000);
});

test('portfolio review sees the unreadable state, not fabricated binary metadata as model evidence',async()=>{
  let prompt: any;
  GeminiGateway.setMockHandler(async request=>{prompt=JSON.parse(String(request.prompt));return JSON.stringify({summary:'مراجعة الوصف فقط؛ الملف لم يُفحص',strengths:[],warnings:['تعذّر قراءة الملف'],corrections:[]});});
  try {
    const result=await AccreditationService.evaluatePortfolio('تصميم',[{title:'نموذج مقدم',description:'وصف العمل المقدم',attachments:[inline(Buffer.from([0,1,2]),'image/png')]}]);
    assert.equal(result.inspected,false);assert.equal(prompt.inspection.contentRead,false);
    assert.equal(prompt.inspection.unavailableSourcesCount,1);assert.deepEqual(prompt.evidence,[]);
    assert.equal(result.status,'PENDING_REVIEW');assert.equal(result.scores.aiScore,null);
  } finally {GeminiGateway.setMockHandler(null);}
});
