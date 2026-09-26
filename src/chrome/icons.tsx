/** Line icons drawn on a 16px grid, in the spirit of SF Symbols. */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const SidebarIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M6 2.75v10.5M3.4 5.4h1.1M3.4 7.4h1.1M3.4 9.4h1.1" />
  </Icon>
);

export const PreviewIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 1.75h5.5l3 3v9.5H4z" />
    <path d="M9.5 1.75v3h3M6 8h4.5M6 10.25h4.5M6 5.75h1.75" />
  </Icon>
);

export const CodeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.25 4.5 1.75 8l3.5 3.5M10.75 4.5l3.5 3.5-3.5 3.5M9.25 3 6.75 13" />
  </Icon>
);

export const SplitIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M8 2.75v10.5" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" {...p} strokeWidth={1.4}>
    <path d="M3.25 3.25l5.5 5.5M8.75 3.25l-5.5 5.5" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 6.25 8 9.75l3.5-3.5" />
  </Icon>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.75 4.5 6.25 8l3.5 3.5" />
  </Icon>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.25 4.5 9.75 8l-3.5 3.5" />
  </Icon>
);

export const DisclosureIcon = (p: IconProps) => (
  <Icon size={12} viewBox="0 0 12 12" {...p} strokeWidth={1.5}>
    <path d="M4.5 3 7.5 6l-3 3" />
  </Icon>
);

export const SearchIcon = (p: IconProps) => (
  <Icon size={13} {...p} strokeWidth={1.5}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3.25 3.25" />
  </Icon>
);

export const DocumentIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
    <path d="M9.25 1.75V5h3.25" />
  </Icon>
);

export const MarkdownDocIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
    <path d="M9.25 1.75V5h3.25M5.75 12V8.5l1.3 1.6 1.3-1.6V12M10.4 8.5V12m-1 -1 1 1 1-1" />
  </Icon>
);

export const FolderIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.4 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
    <path d="M1.75 6.5h12.5" />
  </Icon>
);

export const WarningIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.25 14.25 13H1.75z" />
    <path d="M8 6.5v3M8 11.3v.2" />
  </Icon>
);

export const MissingDocIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 1.75h5.25L12.5 5v9.25H4z" strokeDasharray="2 1.6" />
    <path d="M9.25 1.75V5h3.25" />
  </Icon>
);

export const CloudIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 12.25a2.75 2.75 0 0 1-.4-5.47A4 4 0 0 1 11.8 6a3.1 3.1 0 0 1 .2 6.25z" />
    <path d="M8 7.25v3.5m-1.5-1.5L8 10.75l1.5-1.5" />
  </Icon>
);
