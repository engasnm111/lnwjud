import { Children, isValidElement, type ComponentPropsWithRef, type ReactElement, type ReactNode } from 'react';
import { SearchableSelect } from '../../components/ui/SearchableSelect.js';

type SettingChange = { readonly target: { readonly value: string } };
type SettingsSelectProps = Omit<ComponentPropsWithRef<'select'>, 'onChange' | 'ref'> & {
  readonly onChange?: (event: SettingChange) => void;
};

function plainText(node: ReactNode): string {
  return Children.toArray(node).map((child) =>
    typeof child === 'string' || typeof child === 'number' ? String(child) : '').join('');
}

/** A consistent non-searchable, keyboard-accessible Settings dropdown rendered outside clipped cards. */
export function SettingsSelect(props: SettingsSelectProps): ReactElement {
  const options = Children.toArray(props.children).flatMap((child) => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>(child)) return [];
    if (child.type !== 'option') return [];
    const value = String(child.props.value ?? '');
    return [{ value, label: plainText(child.props.children) }];
  });
  const current = options.find((option) => option.value === String(props.value ?? ''));
  return <SearchableSelect {...(props.id === undefined ? {} : { id: props.id })} value={String(props.value ?? '')} options={options}
    label={props['aria-label'] ?? current?.label ?? props.id ?? 'Select'}
    searchable={false} {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
    className={['settings-select-control', ...((props.className ?? '').split(/\s+/).filter((name) => name && name !== 'settings-select'))].join(' ')}
    onChange={(value) => { props.onChange?.({ target: { value } }); }} />;
}
