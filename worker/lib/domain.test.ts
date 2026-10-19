import { describe, expect, it } from 'vitest';
import { defaultBlogHost, parseHostname, registrableDomain } from '../../shared/domain';

describe('registrableDomain', () => {
  it('drops scheme, path, port, and www', () => {
    expect(registrableDomain('https://www.asd.com/foo?x=1')).toBe('asd.com');
    expect(registrableDomain('http://asd.com:443/path')).toBe('asd.com');
    expect(registrableDomain('asd.com/pricing')).toBe('asd.com');
    expect(registrableDomain('www.asd.com')).toBe('asd.com');
  });

  it('keeps the site domain when a blog subdomain is pasted', () => {
    expect(registrableDomain('blog.xxx.com')).toBe('xxx.com');
    expect(registrableDomain('https://blog.example.com/en/blog/hi')).toBe('example.com');
  });

  it('handles multi-part public suffixes', () => {
    expect(registrableDomain('https://www.shop.asd.com.cn/a')).toBe('asd.com.cn');
    expect(registrableDomain('blog.example.co.uk')).toBe('example.co.uk');
  });

  it('rejects empty or non-domain input', () => {
    expect(registrableDomain('')).toBe('');
    expect(registrableDomain('localhost')).toBe('');
    expect(registrableDomain('not a domain')).toBe('');
  });
});

describe('parseHostname', () => {
  it('keeps the blog host for the SEO module', () => {
    expect(parseHostname('https://blog.asd.com/x')).toBe('blog.asd.com');
    expect(parseHostname('Blog.Example.COM.')).toBe('blog.example.com');
  });
});

describe('defaultBlogHost', () => {
  it('prefixes blog.', () => {
    expect(defaultBlogHost('asd.com')).toBe('blog.asd.com');
  });
});
