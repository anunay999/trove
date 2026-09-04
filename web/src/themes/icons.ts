/**
 * Astryx's semantic icon names, answered with Lucide.
 *
 * The dashboard already draws every other icon from lucide-react, so the chat
 * panel's chevrons and close buttons are the same drawings as the ones beside
 * them. Written with createElement rather than JSX because `astryx theme build`
 * loads this module outside the app's JSX runtime.
 */

import {createElement, type ComponentType, type ReactNode} from 'react';
import type {IconRegistry} from '@astryxdesign/core/Icon';

import {
  X,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Check,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Info,
  Calendar,
  Clock,
  ExternalLink,
  Menu,
  MoreHorizontal,
  Search,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Filter,
  EyeOff,
  Columns,
  Copy,
  CheckCheck,
  Wrench,
  Square,
  Mic,
} from 'lucide-react';

type LucideIcon = ComponentType<{size?: string | number; 'aria-hidden'?: boolean}>;

/** Every icon is 1em and decorative — the label always lives in the markup. */
const icon = (glyph: LucideIcon): ReactNode =>
  createElement(glyph, {size: '1em', 'aria-hidden': true});

export const gothicIconRegistry: IconRegistry = {
  close: icon(X),
  chevronDown: icon(ChevronDown),
  chevronLeft: icon(ChevronLeft),
  chevronRight: icon(ChevronRight),
  chevronsLeft: icon(ChevronsLeft),
  chevronsRight: icon(ChevronsRight),
  check: icon(Check),
  success: icon(CheckCircle),
  error: icon(XCircle),
  warning: icon(AlertTriangle),
  info: icon(Info),
  calendar: icon(Calendar),
  clock: icon(Clock),
  externalLink: icon(ExternalLink),
  menu: icon(Menu),
  moreHorizontal: icon(MoreHorizontal),
  search: icon(Search),
  arrowUp: icon(ArrowUp),
  arrowDown: icon(ArrowDown),
  arrowsUpDown: icon(ArrowUpDown),
  funnel: icon(Filter),
  eyeSlash: icon(EyeOff),
  viewColumns: icon(Columns),
  copy: icon(Copy),
  checkDouble: icon(CheckCheck),
  wrench: icon(Wrench),
  stop: icon(Square),
  microphone: icon(Mic),
};
