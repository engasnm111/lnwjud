import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionButton, FormInput, FormSelect, FormTextarea, FilterBar, FormField, Surface } from '../src/renderer/features/ui/UiPrimitives.js';

describe('shared controls preserve native behavior', () => {
  it('preserves submit, disabled, loading and native attributes on buttons', () => {
    const submit = renderToStaticMarkup(createElement(ActionButton,{type:'submit',className:'custom-action'},'Save'));
    expect(submit).toContain('type="submit"');
    expect(submit).toContain('ui-action');
    expect(submit).toContain('custom-action');
    const busy = renderToStaticMarkup(createElement(ActionButton,{loading:true},'Wait'));
    expect(busy).toContain('disabled=""');
    expect(busy).toContain('aria-busy="true"');
  });
  it('retains labeled text, checkbox, select, textarea, surface and filter semantics', () => {
    const field = renderToStaticMarkup(createElement(FormField,{id:'target',label:'Target',required:true},
      createElement(FormInput,{id:'target',value:'test',readOnly:true})));
    expect(field).toContain('for="target"');
    expect(field).toContain('value="test"');
    expect(renderToStaticMarkup(createElement(FormInput,{type:'checkbox',checked:true,readOnly:true}))).toContain('type="checkbox"');
    expect(renderToStaticMarkup(createElement(FormSelect,{value:'x',onChange:()=>{}},createElement('option',{value:'x'},'Choice')))).toContain('selected=""');
    expect(renderToStaticMarkup(createElement(FormTextarea,{defaultValue:'note'}))).toContain('note');
    expect(renderToStaticMarkup(createElement(FilterBar,{},'Filter'))).toContain('ui-filter-bar');
    expect(renderToStaticMarkup(createElement(Surface,{as:'section'},'Panel'))).toContain('<section');
  });
});
