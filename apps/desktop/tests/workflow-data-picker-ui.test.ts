import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkflowTemplate } from '@lnwjud/ipc-contracts';
import { WorkflowInputForm } from '../src/renderer/features/workflows/WorkflowInputForm.js';

const template = {
  inputFields: [
    {key:'inputPath', labelTh:'ไฟล์ข้อมูล',labelEn:'Data file',type:'path',required:true},
    {key:'sheet',labelTh:'แผ่นงาน',labelEn:'Sheet',type:'text',required:false},
    {key:'keyColumns',labelTh:'คอลัมน์คีย์',labelEn:'Key columns',type:'text',required:true},
  ],
} as WorkflowTemplate;

describe('Workflow data picker behavior', () => {
  it('provides native browse action only for file fields while allowing manual entry', () => {
    const html = renderToStaticMarkup(createElement(WorkflowInputForm, {
      template, locale:'th',values:{inputPath:'data.csv',sheet:'Data'},
      onChange:()=>{},disabled:false,
    }));
    expect(html).toContain('เลือกไฟล์');
    expect(html.match(/ui-browse-button/g)).toHaveLength(1);
    expect(html).toContain('value="data.csv"');
    expect(html).toContain('value="Data"');
  });

  it('disables file browsing with the rest of form during workflow preparation', () => {
    const html = renderToStaticMarkup(createElement(WorkflowInputForm, {
      template,locale:'en',values:{},onChange:()=>{},disabled:true,
    }));
    expect(html).toContain('Browse');
    expect(html).toMatch(/<button(?=[^>]*ui-browse-button)(?=[^>]*disabled="")[^>]*>/);
  });
});
