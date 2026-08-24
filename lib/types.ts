export interface RateLimit {
  interval: number;
  intervalCap: number;
  timeout?: number;
}

export interface EtherscanPlatform {
  domain: string;
  subdomain?: string;
}
