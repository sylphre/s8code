import type { SVGProps } from "react";

export function BrandWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="9.5 6.5 101 47" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M60 30C54.14 36.16 47.9 43.25 38.32 46.1C29.45 48.73 14 44.75 14 30C14 15.25 29.45 11.27 38.32 13.9C47.9 16.75 54.14 23.84 60 30C65.86 36.16 72.1 43.25 81.68 46.1C90.55 48.73 106 44.75 106 30C106 15.25 90.55 11.27 81.68 13.9C72.1 16.75 65.86 23.84 60 30"
        fill="none"
        stroke="currentColor"
        strokeWidth="8.7"
      />
      <circle cx="60" cy="30" r="3.6" fill="var(--color-brand-pink)" />
    </svg>
  );
}
