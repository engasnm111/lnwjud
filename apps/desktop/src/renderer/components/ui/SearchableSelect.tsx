import { useEffect, useId, useRef, useState, type ReactElement } from 'react';

export type SelectOption = { readonly value: string; readonly label: string };

export function SearchableSelect(props: {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
}): ReactElement {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const current = props.options.find((item) => item.value === props.value);
  const matches = props.options.filter((item) =>
    (item.label + ' ' + item.value).toLocaleLowerCase().includes(term.toLocaleLowerCase()),
  );

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return (): void => { document.removeEventListener('pointerdown', onPointer); };
  }, [open]);

  function choose(value: string): void {
    props.onChange(value);
    setOpen(false);
    setTerm('');
    setActive(0);
  }

  return (
    <div ref={root} className={`ui-combobox ${props.className ?? ''}`}>
      <button type="button" className="ui-combobox-trigger" disabled={props.disabled}
        aria-label={props.label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox"
        onClick={() => { setTerm(''); setActive(0); setOpen(!open); }}>
        <span>{current?.label ?? props.placeholder ?? props.label}</span><span aria-hidden="true">⌄</span>
      </button>
      {open ? <div className="ui-combobox-popover">
        <input ref={search} autoFocus type="search" role="combobox" aria-label={props.label}
          aria-autocomplete="list" aria-controls={id} aria-expanded={true}
          value={term} placeholder={props.placeholder ?? props.label}
          onChange={(event) => { setTerm(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { setOpen(false); }
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            if (event.key === 'Enter' && matches[active]) { event.preventDefault(); choose(matches[active].value); }
          }} />
        <div id={id} role="listbox" className="ui-combobox-options" aria-label={props.label}>
          {matches.length === 0 ? <div className="ui-combobox-empty">No matches</div> : matches.map((item, i) => (
            <button type="button" role="option" aria-selected={item.value === props.value}
              className={i === active ? 'ui-combobox-option highlighted' : 'ui-combobox-option'}
              key={item.value} onMouseEnter={() => setActive(i)} onClick={() => choose(item.value)}>
              {item.label}
            </button>
          ))}
        </div>
      </div> : null}
    </div>
  );
}
