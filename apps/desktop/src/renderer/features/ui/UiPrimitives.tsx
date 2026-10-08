import type { ComponentPropsWithRef, HTMLAttributes, ReactElement, ReactNode } from 'react';

interface HeadingProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly eyebrow?: ReactNode;
  readonly eyebrowClassName?: string;
}

export function PageHeading({ title, subtitle, actions, className, eyebrow, eyebrowClassName }: HeadingProps): ReactElement {
  return (
    <div className={['page-heading', className].filter(Boolean).join(' ')}>
      <div>
        {eyebrow === undefined ? null : <span className={eyebrowClassName ?? 'page-eyebrow'}>{eyebrow}</span>}
        <h1>{title}</h1>
        {subtitle === undefined ? null : <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions === undefined ? null : <div className="heading-actions">{actions}</div>}
    </div>
  );
}

export function SectionHeading({ title, subtitle, actions, className }: HeadingProps): ReactElement {
  return (
    <div className={['section-heading', className].filter(Boolean).join(' ')}>
      <div>
        {typeof title === 'string' ? <h2>{title}</h2> : title}
        {subtitle === undefined ? null : <p className="hint">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

interface SettingsCardHeadingProps {
  readonly icon: string;
  readonly title: ReactNode;
  readonly subtitle: ReactNode;
  readonly badge?: ReactNode;
  readonly action?: ReactNode;
}

export function SettingsCardHeading({ icon, title, subtitle, badge, action }: SettingsCardHeadingProps): ReactElement {
  return (
    <div className="section-heading settings-card-heading">
      <div className="settings-heading-copy">
        <span className="settings-card-icon" aria-hidden="true">{icon}</span>
        <div>
          <h2 className="settings-card-title">{title}</h2>
          <span className="page-subtitle">{subtitle}</span>
        </div>
      </div>
      {action ?? (badge === undefined ? null : <span className="pill-badge gold">{badge}</span>)}
    </div>
  );
}

interface StatusMessageProps {
  readonly children: ReactNode;
  readonly tone?: 'warning' | 'success' | 'neutral';
  readonly role?: 'alert' | 'status' | 'note';
  readonly className?: string;
  readonly prefix?: ReactNode;
}

export function StatusMessage({ children, tone = 'neutral', role = 'status', className, prefix }: StatusMessageProps): ReactElement {
  const toneClass = tone === 'warning' ? 'alert-box-warning' : tone === 'success' ? 'toast-success-banner' : 'hint';
  return <div className={[toneClass, className].filter(Boolean).join(' ')} role={role}>{prefix}{children}</div>;
}

interface EmptyStateProps {
  readonly children: ReactNode;
  readonly variant?: 'settings' | 'doctor';
  readonly className?: string;
}

export function EmptyState({ children, variant = 'settings', className }: EmptyStateProps): ReactElement {
  const base = variant === 'doctor' ? 'doctor-empty-state' : 'empty-setting-state';
  return <div className={[base, className].filter(Boolean).join(' ')}>{children}</div>;
}


export type ActionVariant = 'default' | 'primary' | 'ghost' | 'danger';

export function ActionButton({ variant = 'default', loading = false, className, disabled, type = 'button', ...props }:
  ComponentPropsWithRef<'button'> & { readonly variant?: ActionVariant; readonly loading?: boolean }): ReactElement {
  return <button {...props} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
    className={['ui-action', `ui-action--${variant}`, className].filter(Boolean).join(' ')} />;
}

export function FormInput({ className, type = 'text', ...props }: ComponentPropsWithRef<'input'>): ReactElement {
  return <input {...props} type={type} className={[type === 'checkbox' || type === 'radio' ? '' : 'ui-text-input', className].filter(Boolean).join(' ')} />;
}

export function FormSelect({ className, ...props }: ComponentPropsWithRef<'select'>): ReactElement {
  return <select {...props} className={['ui-native-select', className].filter(Boolean).join(' ')} />;
}

export function FormTextarea({ className, ...props }: ComponentPropsWithRef<'textarea'>): ReactElement {
  return <textarea {...props} className={['ui-text-area', className].filter(Boolean).join(' ')} />;
}

export function FilterBar({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div {...props} className={['ui-filter-bar', className].filter(Boolean).join(' ')} />;
}

export function FormField({ id, label, required, className, children }: {
  readonly id: string;
  readonly label: ReactNode;
  readonly required?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  return <div className={['ui-form-field', className].filter(Boolean).join(' ')}>
    <label htmlFor={id}>{label}{required ? ' *' : null}</label>
    {children}
  </div>;
}

export function Surface({ as = 'div', className, children, ...props }:
  HTMLAttributes<HTMLDivElement> & { readonly as?: 'div' | 'section' }): ReactElement {
  const classes = ['ui-surface', className].filter(Boolean).join(' ');
  return as === 'section' ? <section {...props} className={classes}>{children}</section> : <div {...props} className={classes}>{children}</div>;
}
