import { parseOrigins } from '../../src/config/environment';

describe('parseOrigins (CORS_ORIGIN)', () => {
  it('trims spaces around commas', () => {
    expect(parseOrigins('https://a.example.com, https://b.example.com')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('drops empty entries', () => {
    expect(parseOrigins(' https://a.example.com ,, ,')).toEqual(['https://a.example.com']);
  });

  it('keeps a single origin as is', () => {
    expect(parseOrigins('http://localhost:3000')).toEqual(['http://localhost:3000']);
  });
});
