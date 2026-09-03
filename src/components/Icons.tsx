import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }
const icon = (path: ReactNode, props: IconProps) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width={props.size ?? 20} height={props.size ?? 20} {...props}>{path}</svg>

export const GridIcon = (props: IconProps) => icon(<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>, props)
export const CashIcon = (props: IconProps) => icon(<><rect x="2.8" y="5" width="18.4" height="14" rx="2"/><circle cx="12" cy="12" r="3.2"/><path d="M6.2 9.1h.01M17.8 14.9h.01"/></>, props)
export const ChartIcon = (props: IconProps) => icon(<><path d="M4 19V5M4 19h17"/><path d="m7 15 3.2-4 3.1 2.4L19 7"/></>, props)
export const ReceiptIcon = (props: IconProps) => icon(<><path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Z"/><path d="M8 8h8M8 12h8M8 16h4"/></>, props)
export const SettingsIcon = (props: IconProps) => icon(<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.7 1.7-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20h-2.4v-.2a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-1.7-1.7.06-.06A1.7 1.7 0 0 0 8.46 15a1.7 1.7 0 0 0-1.56-1.03H6v-2.4h.9a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.88l-.06-.06 1.7-1.7.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 12.73 5.7V4h2.4v1.7a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.7 1.7-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03H22v2.4h-.9A1.7 1.7 0 0 0 19.4 15Z"/></>, props)
export const LogOutIcon = (props: IconProps) => icon(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></>, props)
export const PlusIcon = (props: IconProps) => icon(<><path d="M12 5v14M5 12h14"/></>, props)
export const ArrowIcon = (props: IconProps) => icon(<><path d="M5 12h14M13 6l6 6-6 6"/></>, props)
export const ChevronIcon = (props: IconProps) => icon(<path d="m8 10 4 4 4-4"/>, props)
export const BellIcon = (props: IconProps) => icon(<><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>, props)
export const CheckIcon = (props: IconProps) => icon(<path d="m5 12 4 4L19 6"/>, props)
export const ClockIcon = (props: IconProps) => icon(<><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></>, props)
export const QrIcon = (props: IconProps) => icon(<><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h3v3h-3zM20 14v6M14 20h3"/></>, props)
export const DownloadIcon = (props: IconProps) => icon(<><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></>, props)
export const SearchIcon = (props: IconProps) => icon(<><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>, props)
export const FilterIcon = (props: IconProps) => icon(<path d="M4 6h16M7 12h10M10 18h4"/>, props)
export const MenuIcon = (props: IconProps) => icon(<><path d="M4 6h16M4 12h16M4 18h16"/></>, props)
export const CloseIcon = (props: IconProps) => icon(<><path d="m6 6 12 12M18 6 6 18"/></>, props)
export const InfoIcon = (props: IconProps) => icon(<><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></>, props)
export const CopyIcon = (props: IconProps) => icon(<><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>, props)
