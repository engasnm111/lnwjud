import { ActionButton, FormInput } from '../../features/ui/UiPrimitives.js';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

export type SelectOption = { readonly value: string; readonly label: string };

export function SearchableSelect(props: {
  readonly id?: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
  readonly invalid?: boolean;
  readonly describedBy?: string | undefined;
}): ReactElement {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const current = props.options.find((item) => item.value === props.value);
  const matches = props.options.filter((item) =>
    (item.label + ' ' + item.value).toLocaleLowerCase().includes(term.toLocaleLowerCase()),
  );

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = (): void => {
      const rect = root.current?.getBoundingClientRect();
      if (!rect) return;
      const below = Math.max(0, window.innerHeight - rect.bottom - 14);
      const above = Math.max(0, rect.top - 14);
      const desiredHeight = Math.min(310, popover.current?.scrollHeight ?? 310);
      const flip = below < Math.min(220, desiredHeight) && above > below;
      const maxHeight = Math.max(56, Math.min(310, flip ? above : below));
      const width = Math.max(0, Math.min(rect.width, window.innerWidth - 16));
      setPlacement({
        width, maxHeight,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: flip ? Math.max(8, rect.top - 6 - Math.min(maxHeight, desiredHeight)) : rect.bottom + 6,
      });
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return (): void => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, matches.length]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !popover.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return (): void => { document.removeEventListener('pointerdown', onPointer); };
  }, [open]);

  function close(): void {
    setOpen(false);
    setTerm('');
    setActive(0);
    root.current?.querySelector('button')?.focus();
  }

  function choose(value: string): void {
    props.onChange(value);
    close();
  }

  return (
    <div ref={root} className={`ui-combobox ${props.className ?? ''}`}>
      <ActionButton id={props.id} type="button" className="ui-combobox-trigger" disabled={props.disabled}
        aria-label={props.label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox"
        aria-invalid={props.invalid || undefined} aria-describedby={props.describedBy}
        onClick={() => { setTerm(''); setActive(0); setPlacement(null); setOpen(!open); }}>
        <span>{current?.label ?? props.placeholder ?? props.label}</span><span aria-hidden="true">⌄</span>
      </ActionButton>
      {open ? createPortal(
        <div ref={popover} className="ui-combobox-popover"
          style={{ top: placement?.top ?? 0, left: placement?.left ?? 0,
            width: placement?.width ?? 0, maxHeight: placement?.maxHeight ?? 310,
            visibility: placement ? 'visible' : 'hidden' }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          }}>
          <FormInput autoFocus type="search" role="combobox" aria-label={props.label}
            aria-autocomplete="list" aria-controls={id} aria-expanded={true}
            aria-activedescendant={matches[active] ? `${id}-option-${active}` : undefined}
            value={term} placeholder={props.placeholder ?? props.label}
            onChange={(event) => { setTerm(event.target.value); setActive(0); }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
              if (event.key === 'Enter' && matches[active]) { event.preventDefault(); choose(matches[active].value); }
            }} />
          <div id={id} role="listbox" className="ui-combobox-options" aria-label={props.label}>
            {matches.length === 0 ? <div className="ui-combobox-empty">No matches</div> : matches.map((item, i) => (
              <ActionButton type="button" role="option" id={`${id}-option-${i}`}
                aria-selected={item.value === props.value}
                className={i === active ? 'ui-combobox-option highlighted' : 'ui-combobox-option'}
                key={item.value} onMouseEnter={() => setActive(i)} onClick={() => choose(item.value)}>
                {item.label}
              </ActionButton>
            ))}
          </div>
        </div>, document.body,
      ) : null}
    </div>
  );
}
