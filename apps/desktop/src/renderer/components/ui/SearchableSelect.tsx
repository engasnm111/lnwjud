import { ActionButton, FormInput } from '../../features/ui/UiPrimitives.js';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
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
  readonly searchable?: boolean;
}): ReactElement {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const tooltipHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didScrollOnOpen = useRef(false);
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const [fullLabel, setFullLabel] = useState<{ text: string; top: number; left: number; width: number; maxHeight: number } | null>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const current = props.options.find((item) => item.value === props.value);
  const matches = useMemo(() => props.options.filter((item) =>
    (item.label + ' ' + item.value).toLocaleLowerCase().includes(term.toLocaleLowerCase()),
  ), [props.options, term]);

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = (): void => {
      setFullLabel(null);
      let rect = root.current?.getBoundingClientRect();
      if (!rect) return;
      // This control never opens upwards. Move the surrounding scroll region once
      // when needed, then scroll inside the bounded list for additional options.
      if (!didScrollOnOpen.current && window.innerHeight - rect.bottom < 190) {
        didScrollOnOpen.current = true;
        root.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
        rect = root.current?.getBoundingClientRect() ?? rect;
      }
      const below = Math.max(0, window.innerHeight - rect.bottom - 14);
      const maxHeight = Math.max(72, Math.min(310, below));
      // Fit short option sets to their actual labels; clamp very long Goals/tools to
      // a readable maximum, where each item wraps to at most three lines.
      const availableWidth = Math.max(0, window.innerWidth - 16);
      const optionStyle = window.getComputedStyle(
        popover.current?.querySelector<HTMLElement>('.ui-combobox-option') ?? root.current!,
      );
      const measure = document.createElement('canvas').getContext('2d');
      if (measure) measure.font = `${optionStyle.fontWeight} ${optionStyle.fontSize} ${optionStyle.fontFamily}`;
      let widestLabel = 0;
      for (const item of matches) {
        const measured = measure?.measureText(item.label).width ?? item.label.length * 7;
        widestLabel = Math.max(widestLabel, measured);
        if (widestLabel >= 520) break;
      }
      const contentWidth = Math.ceil(widestLabel + 48);
      const width = Math.min(availableWidth, Math.max(rect.width, 160, Math.min(520, contentWidth)));
      setPlacement({
        width, maxHeight,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: rect.bottom + 6,
      });
    };
    const onScroll = (event: Event): void => {
      // Scrolling long option lists or full-text previews must not dismiss their own tooltip.
      if (event.target instanceof Node &&
        (popover.current?.contains(event.target) || tooltip.current?.contains(event.target))) return;
      reposition();
    };
    reposition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', reposition);
    return (): void => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, matches.length]);

  useEffect(() => {
    if (!open) setFullLabel(null);
    return (): void => {
      if (tooltipHideTimer.current !== null) clearTimeout(tooltipHideTimer.current);
      tooltipHideTimer.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open || props.searchable !== false) return;
    const selected = popover.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')
      ?? popover.current?.querySelector<HTMLButtonElement>('[role="option"]');
    selected?.focus();
  }, [open, props.searchable]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !popover.current?.contains(event.target) &&
        !tooltip.current?.contains(event.target)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setTerm('');
      setActive(0);
      root.current?.querySelector('button')?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onEscape, true);
    return (): void => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onEscape, true);
    };
  }, [open]);

  function close(): void {
    didScrollOnOpen.current = false;
    setOpen(false);
    setTerm('');
    setActive(0);
    if (tooltipHideTimer.current !== null) clearTimeout(tooltipHideTimer.current);
    tooltipHideTimer.current = null;
    setFullLabel(null);
    root.current?.querySelector('button')?.focus();
  }

  function hideFullLabelSoon(): void {
    if (tooltipHideTimer.current !== null) clearTimeout(tooltipHideTimer.current);
    tooltipHideTimer.current = setTimeout(() => {
      tooltipHideTimer.current = null;
      setFullLabel(null);
    }, 180);
  }

  function showFullLabel(text: string, element: HTMLElement): void {
    if (tooltipHideTimer.current !== null) clearTimeout(tooltipHideTimer.current);
    tooltipHideTimer.current = null;
    const label = element.querySelector<HTMLElement>('.ui-combobox-option-label');
    if (!label || label.scrollHeight <= label.clientHeight + 1) { setFullLabel(null); return; }
    const rect = element.getBoundingClientRect();
    const popupRect = popover.current?.getBoundingClientRect() ?? rect;
    const viewportWidth = window.innerWidth;
    const rightSpace = viewportWidth - popupRect.right - 12;
    const leftSpace = popupRect.left - 12;
    let maxHeight = Math.min(240, window.innerHeight - 16);
    let width = Math.min(440, viewportWidth - 16);
    let left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
    let top = Math.max(8, Math.min(rect.top, window.innerHeight - maxHeight - 8));
    if (rightSpace >= 260) {
      width = Math.min(440, rightSpace);
      left = popupRect.right + 8;
    } else if (leftSpace >= 260) {
      width = Math.min(440, leftSpace);
      left = popupRect.left - width - 8;
    } else {
      // On narrow screens keep the full-text preview above/below the menu, not over its rows.
      const above = Math.max(0, popupRect.top - 16);
      const below = Math.max(0, window.innerHeight - popupRect.bottom - 16);
      const available = Math.max(above, below);
      maxHeight = Math.max(16, Math.min(220, available));
      top = above >= below ? Math.max(8, popupRect.top - maxHeight - 8)
        : Math.min(window.innerHeight - maxHeight - 8, popupRect.bottom + 8);
    }
    setFullLabel({ text, top, left, width, maxHeight });
  }

  function choose(value: string): void {
    props.onChange(value);
    close();
  }

  return (
    <div ref={root} className={`ui-combobox ${props.className ?? ''}`}>
      <ActionButton id={props.id} type="button" data-value={props.value} className="ui-combobox-trigger" disabled={props.disabled}
        aria-label={props.label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox"
        aria-invalid={props.invalid || undefined} aria-describedby={props.describedBy}
        onClick={() => { didScrollOnOpen.current = false; setTerm(''); setActive(0); setPlacement(null); setOpen(!open); }}>
        <span title={current?.label ?? props.placeholder ?? props.label}>{current?.label ?? props.placeholder ?? props.label}</span><span aria-hidden="true">⌄</span>
      </ActionButton>
      {open ? createPortal(
        <div ref={popover} className="ui-combobox-popover"
          style={{ top: placement?.top ?? 0, left: placement?.left ?? 0,
            width: placement?.width ?? 0, maxHeight: placement?.maxHeight ?? 310,
            visibility: placement ? 'visible' : 'hidden' }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
            if (props.searchable !== false) return;
            const optionButtons = Array.from(popover.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const index = optionButtons.indexOf(document.activeElement as HTMLButtonElement);
              const next = Math.max(0, Math.min(optionButtons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
              optionButtons[next]?.focus(); setActive(next);
            }
            if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault(); const next = event.key === 'Home' ? 0 : optionButtons.length - 1;
              optionButtons[next]?.focus(); setActive(next);
            }
          }}>
          {props.searchable === false ? null : <FormInput autoFocus type="search" role="combobox" aria-label={props.label}
            aria-autocomplete="list" aria-controls={id} aria-expanded={true}
            aria-activedescendant={matches[active] ? `${id}-option-${active}` : undefined}
            value={term} placeholder={props.placeholder ?? props.label}
            onChange={(event) => { setTerm(event.target.value); setActive(0); }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
              if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
              if (event.key === 'Enter' && matches[active]) { event.preventDefault(); choose(matches[active].value); }
            }} />}
          <div id={id} role="listbox" className="ui-combobox-options" aria-label={props.label}
            onScroll={() => setFullLabel(null)}>
            {matches.length === 0 ? <div className="ui-combobox-empty">No matches</div> : matches.map((item, i) => (
              <ActionButton type="button" role="option" id={`${id}-option-${i}`}
                aria-selected={item.value === props.value}
                className={i === active ? 'ui-combobox-option highlighted' : 'ui-combobox-option'}
                key={item.value} aria-label={item.label}
                onMouseEnter={(event) => { setActive(i); showFullLabel(item.label, event.currentTarget); }}
                onMouseLeave={(event) => {
                  if (!(event.relatedTarget instanceof Node) || !tooltip.current?.contains(event.relatedTarget)) hideFullLabelSoon();
                }}
                onFocus={(event) => showFullLabel(item.label, event.currentTarget)}
                onBlur={() => setFullLabel(null)} onClick={() => choose(item.value)}>
                <span className="ui-combobox-option-label">{item.label}</span>
              </ActionButton>
            ))}
          </div>
        </div>, document.body,
      ) : null}
      {open && fullLabel ? createPortal(
        <div ref={tooltip} role="tooltip" className="ui-combobox-full-label"
          onMouseEnter={() => {
            if (tooltipHideTimer.current !== null) clearTimeout(tooltipHideTimer.current);
            tooltipHideTimer.current = null;
          }}
          onMouseLeave={hideFullLabelSoon}
          style={{ top: fullLabel.top, left: fullLabel.left, width: fullLabel.width, maxHeight: fullLabel.maxHeight }}>
          {fullLabel.text}
        </div>, document.body,
      ) : null}
    </div>
  );
}
