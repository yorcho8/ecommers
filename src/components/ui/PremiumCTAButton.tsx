import React from "react";

type CTAButtonVariant = "primary" | "secondary";
type CTAButtonSize = "sm" | "md" | "lg";

export interface PremiumCTAButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: CTAButtonVariant;
  size?: CTAButtonSize;
  loading?: boolean;
  pulse?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
}

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

const sizeClasses: Record<CTAButtonSize, string> = {
  sm: "h-10 px-4 text-sm",
  md: "h-12 px-6 text-base",
  lg: "h-14 px-7 text-lg",
};

const variantClasses: Record<CTAButtonVariant, string> = {
  primary:
    "text-white border border-orange-300/35 bg-gradient-to-b from-orange-500 via-orange-500 to-amber-500 shadow-[0_10px_28px_rgba(249,115,22,0.35)] hover:shadow-[0_14px_34px_rgba(249,115,22,0.45)]",
  secondary:
    "text-zinc-100 border border-white/25 bg-white/5 shadow-[0_8px_20px_rgba(0,0,0,0.22)] hover:bg-white/10 hover:border-orange-300/45",
};

export const PremiumCTAButton = React.forwardRef<
  HTMLButtonElement,
  PremiumCTAButtonProps
>(function PremiumCTAButton(
  {
    children,
    variant = "primary",
    size = "md",
    loading = false,
    disabled = false,
    pulse = false,
    iconLeft,
    iconRight,
    className,
    ...props
  },
  ref,
) {
  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      disabled={isDisabled}
      aria-busy={loading}
      className={cn(
        "group relative inline-flex items-center justify-center gap-2 rounded-2xl font-semibold tracking-[0.01em]",
        "transition-all duration-200 ease-in-out will-change-transform",
        "hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/85 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
        "disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none disabled:transform-none",
        pulse && !isDisabled && "animate-pulse",
        sizeClasses[size],
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-r from-white/18 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

      {loading ? (
        <>
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-white/35 border-t-white"
          />
          <span>Cargando...</span>
        </>
      ) : (
        <>
          {iconLeft ? <span className="shrink-0">{iconLeft}</span> : null}
          <span>{children}</span>
          {iconRight ? <span className="shrink-0">{iconRight}</span> : null}
        </>
      )}
    </button>
  );
});

export default PremiumCTAButton;
