export interface AnalyticsApiError {
  message?: string;
  status?: string;
  errors?: unknown[];
}

export interface AnalyticsAccount {
  name: string;
  accountId: string;
  displayName?: string;
}

export interface AnalyticsProperty {
  name: string;
  propertyId: string;
  parent: string;
  displayName?: string;
  timeZone?: string;
  currencyCode?: string;
}

export interface AnalyticsDataStream {
  name: string;
  streamId: string;
  propertyId: string;
  displayName?: string;
  type: string;
  measurementId?: string;
  defaultUri?: string;
}

export interface AnalyticsReport {
  propertyId: string;
  eventName: string;
  totalEvents: number;
  startDate: string;
  endDate: string;
  sourceHealthy: true;
}

export interface AnalyticsVisitorsReport {
  propertyId: string;
  metric: "totalUsers";
  totalUsers: number;
  startDate: string;
  endDate: string;
  sourceHealthy: true;
}
