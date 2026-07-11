import { createContext } from 'react';
import type { RootAnalytics } from '@randomtoni/analytics-kit';

export const NOT_IN_PROVIDER = Symbol('analytics-kit.not-in-provider');

export type AnalyticsClientContextValue = RootAnalytics | typeof NOT_IN_PROVIDER;

export const AnalyticsClientContext =
  createContext<AnalyticsClientContextValue>(NOT_IN_PROVIDER);
