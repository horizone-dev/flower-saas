import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn.js';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  children: ReactNode;
}

const VARIANT_CLASS: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'fl-btn fl-btn--primary',
  secondary: 'fl-btn fl-btn--secondary',
  ghost: 'fl-btn fl-btn--ghost',
};

export function Button({ variant = 'primary', className, children, ...rest }: ButtonProps) {
  return (
    <button className={cn(VARIANT_CLASS[variant], className)} {...rest}>
      {children}
    </button>
  );
}
