import { z } from 'zod';

export type TradovateEnvironment = 'demo';

export interface TradovateCredentials {
  environment: TradovateEnvironment;
  username: string;
  password: string;
  cid: string;
  sec: string;
}

export interface TradovateAccount {
  id: number;
  name: string;
}

const tokenSchema = z.object({
  accessToken: z.string().min(1),
});

const accountsSchema = z.array(z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
}));

export class TradovateClient {
  private static readonly demoBaseUrl = 'https://demo.tradovateapi.com/v1';

  private constructor(
    credentials: TradovateCredentials,
    private readonly accessToken: string,
  ) {}

  static async connect(credentials: TradovateCredentials): Promise<TradovateClient> {
    const response = await fetch(`${this.demoBaseUrl}/auth/accesstokenrequest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: credentials.username,
        password: credentials.password,
        appId: 'tradovate-browser-bridge',
        appVersion: '0.1.1',
        cid: credentials.cid,
        sec: credentials.sec,
      }),
    });
    const body = await response.json() as unknown;
    if (!response.ok) throw new Error('Tradovate authentication failed');
    return new TradovateClient(credentials, tokenSchema.parse(body).accessToken);
  }

  async listAccounts(): Promise<TradovateAccount[]> {
    const response = await fetch(`${TradovateClient.demoBaseUrl}/account/list`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    const body = await response.json() as unknown;
    if (!response.ok) throw new Error('Tradovate account discovery failed');
    return accountsSchema.parse(body);
  }
}
