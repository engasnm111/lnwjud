import { describe, expect, it } from 'vitest';
import { observedMutationReceipt } from './task-mutation-receipt.js';
describe('first-party mutation evidence',()=>{
  it('returns a bounded server receipt for a real successful write response',()=>{
    expect(observedMutationReceipt('write_file',{
      content:[{type:'text',text:''}],
      structuredContent:{path:'src/app.ts',bytesWritten:3,checkpointId:'checkpoint-1'},
    })).toEqual({path:'src/app.ts',action:'write_file',checkpointId:'checkpoint-1'});
  });
  it('ignores failed, unknown, unverified and bogus outputs',()=>{
    expect(observedMutationReceipt('write_file',{isError:true,content:[],structuredContent:{path:'x'}})).toBeUndefined();
    expect(observedMutationReceipt('shell',{content:[],structuredContent:{path:'x'}})).toBeUndefined();
    expect(observedMutationReceipt('office_excel',{content:[],structuredContent:{path:'out.xlsx',verification:'unknown'}})).toBeUndefined();
    expect(observedMutationReceipt('write_file',{content:[],structuredContent:{path:'a\0b'}})).toBeUndefined();
  });
  it('records only readback-verified Office report artifact size and SHA',()=>{
    const receipt=observedMutationReceipt('office_excel',{content:[],
      structuredContent:{path:'in.csv',outputPath:'reports/out.xlsx',provider:'file_xlsx',verification:'verified',sha256:'b'.repeat(64),sizeBytes:381},
    });
    expect(receipt).toEqual({path:'reports/out.xlsx',action:'office_excel',afterSha256:'b'.repeat(64),sizeBytes:381,verification:'verified'});
  });
});
