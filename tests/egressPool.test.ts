/**
 * 代理池的读取面：把后端的一行归一成界面要的形状。
 *
 * 这里守三条不能含糊的规则：
 *   1. 没有地址就不算测通 —— 「没测过」不能被显示成「通了」；
 *   2. 缺计数只保证不变成 NaN，不假装它是「没人用」的证据；
 *   3. 下拉框的编号必须能分辨，停用的也要能选（它还挂着账号）。
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import {
  egressOptions,
  normalizeEgressPoolEntry,
  orderEgressChoices,
} from '@/services/api/egressPool';
import { blockEgressId } from '@/features/sms/smsMapping';
import type { SupplyKindConfig } from '@/features/sms/types';

describe('egress pool entry normalization', () => {
  test('drops a row without an id, because an id is the only handle', () => {
    expect(normalizeEgressPoolEntry({ url: 'socks5://a:***@1.2.3.4:1080' })).toBeNull();
    expect(normalizeEgressPoolEntry({ id: 0, url: 'socks5://x' })).toBeNull();
    expect(normalizeEgressPoolEntry(null)).toBeNull();
  });

  test('splits the probe answer into address, region and network', () => {
    const entry = normalizeEgressPoolEntry({
      id: 2,
      url: 'socks5://user:***@1.2.3.4:1080',
      label: '香港 1',
      enabled: true,
      last_probe: {
        ok: true,
        ip: '96.62.251.108',
        country: 'Hong Kong',
        city: 'Hong Kong',
        asn: 'AS9009',
        org: 'M247 Europe SRL',
        latency_ms: 213,
        at: 1_760_000_000,
      },
      counts: { account: 3, channel: 1 },
      total: 4,
    });

    expect(entry).not.toBeNull();
    expect(entry?.id).toBe(2);
    expect(entry?.label).toBe('香港 1');
    expect(entry?.probe).toMatchObject({
      ok: true,
      ip: '96.62.251.108',
      region: 'Hong Kong · Hong Kong',
      network: 'AS9009 M247 Europe SRL',
      latencyMs: 213,
      at: 1_760_000_000,
    });
    // 账号与渠道分开报，总数由后端给：删不掉时那句话里的数字必须是后端认的那个，
    // 界面自己再加一遍就会和它差一。
    expect(entry?.accounts).toBe(3);
    expect(entry?.channels).toBe(1);
    expect(entry?.total).toBe(4);
  });

  test('keeps "never tested" distinct from "tested and failed"', () => {
    const never = normalizeEgressPoolEntry({ id: 1, url: 'socks5://a', counts: {} });
    expect(never?.probe).toBeNull();

    const failed = normalizeEgressPoolEntry({
      id: 2,
      url: 'socks5://b',
      last_probe: { ok: false, error: 'dial tcp: connection refused', at: 1 },
      counts: {},
    });
    expect(failed?.probe?.ok).toBe(false);
    expect(failed?.probe?.error).toBe('dial tcp: connection refused');
    // 失败的那次没有地址，就没有可显示的地区与网络。
    expect(failed?.probe?.ip).toBe('');
    expect(failed?.probe?.region).toBe('');
  });

  test('reads a missing count as zero rather than NaN, and says so in one place', () => {
    // 后端始终会带 counts；这里只是不让一个缺字段变成 NaN 传到界面上。
    // 真正的「不知道」不在这条链路上表达，所以名字只说它做的事。
    const entry = normalizeEgressPoolEntry({ id: 3, url: 'socks5://c' });
    expect(entry?.accounts).toBe(0);
    expect(entry?.channels).toBe(0);
    expect(entry?.total).toBe(0);
  });

  test('treats a missing enabled flag as enabled, since entries default to on', () => {
    expect(normalizeEgressPoolEntry({ id: 4, url: 'socks5://d' })?.enabled).toBe(true);
    expect(normalizeEgressPoolEntry({ id: 4, url: 'socks5://d', enabled: false })?.enabled).toBe(
      false
    );
  });
});

describe('egress select options', () => {
  const entries = [
    normalizeEgressPoolEntry({
      id: 1,
      url: 'socks5://user:***@1.2.3.4:1080',
      label: '香港 1',
      last_probe: { ok: true, ip: '1.2.3.4' },
      counts: {},
    })!,
    normalizeEgressPoolEntry({
      id: 2,
      url: 'socks5://user:***@5.6.7.8:1080',
      enabled: false,
      counts: {},
    })!,
  ];

  test('leads with the id so two unnamed addresses stay distinguishable', () => {
    const options = egressOptions(entries);
    expect(options[0].value).toBe('1');
    expect(options[0].label).toBe('#1 香港 1');
    // 地址单独一行：挤在标题里时，被截断掉的恰好是唯一能分辨的那一段。
    expect(options[0].description).toBe('socks5://user:***@1.2.3.4:1080');
    // 没有名字就只有编号，它仍然能让人认出是哪一条。
    expect(options[1].label).toBe('#2');
    expect(options[1].description).toBe('socks5://user:***@5.6.7.8:1080');
  });

  test('keeps paused exits selectable, marked for the caller to label', () => {
    const options = egressOptions(entries);
    expect(options.map((option) => option.enabled)).toEqual([true, false]);
  });

  test('keeps the address out of the title even when the last test failed', () => {
    const failed = normalizeEgressPoolEntry({
      id: 3,
      url: 'socks5://user:***@9.9.9.9:1080',
      last_probe: { ok: false, error: 'timeout' },
      counts: {},
    })!;
    const option = egressOptions([failed])[0];
    expect(option.label).toBe('#3');
    expect(option.description).toBe('socks5://user:***@9.9.9.9:1080');
  });
});

/**
 * 下拉框打开后看到的前两行，就是这一格要回答的两件事：怎么解绑、现在绑的是哪条。
 *
 * 这两行不能靠池内编号碰运气：绑在第 7 条上时，它就会落到第 8 行，得在一列勾里找。
 */
describe('egress binding dropdown order', () => {
  const direct = { value: '', label: '直连' };
  const pool = [
    { value: '1', label: '#1 日本' },
    { value: '2', label: '#2 香港' },
    { value: '3', label: '#3 美国' },
  ];

  test('pins the unbind row first and the current binding right under it', () => {
    expect(orderEgressChoices(direct, pool, '2').map((choice) => choice.value)).toEqual([
      '',
      '2',
      '1',
      '3',
    ]);
  });

  test('leaves the pool order alone when nothing is bound', () => {
    expect(orderEgressChoices(direct, pool, '').map((choice) => choice.value)).toEqual([
      '',
      '1',
      '2',
      '3',
    ]);
  });

  test('keeps the unbind row first even when it is the current value', () => {
    const choices = orderEgressChoices(direct, pool, '');
    expect(choices[0].label).toBe('直连');
  });

  test('promotes a deleted exit that is still the current binding', () => {
    const deleted = { value: '9', label: '#9 已不存在' };
    expect(
      orderEgressChoices(direct, [...pool, deleted], '9').map((choice) => choice.value)
    ).toEqual(['', '9', '1', '2', '3']);
  });

  test('never repeats the current row, even if the caller lists it twice', () => {
    const choices = orderEgressChoices(direct, [...pool, { value: '2', label: '#2 香港' }], '2');
    expect(choices.map((choice) => choice.value)).toEqual(['', '2', '1', '3']);
  });
});

describe('egress_pool locale keys', () => {
  const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'];

  const readPool = (locale: string): Record<string, string> => {
    const parsed = JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, 'utf8')) as {
      egress_pool?: Record<string, string>;
    };
    return parsed.egress_pool ?? {};
  };

  test('every key the UI asks for exists, so no raw key reaches the page', () => {
    const files = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter((file) =>
      /\.tsx?$/.test(file)
    );
    const used = new Set<string>();
    for (const file of files) {
      const source = readFileSync(`src/${file}`, 'utf8');
      for (const match of source.matchAll(/['"]egress_pool\.([a-z0-9_]+)['"]/g)) {
        used.add(match[1]);
      }
    }

    const defined = new Set(Object.keys(readPool('en')));
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((key) => !defined.has(key))).toEqual([]);
  });

  test('all six locales carry the same keys, so none of them falls back to English', () => {
    // 只有 en 有键、其余靠 fallback 的话，别的语言里会突然冒出英文句子；
    // 缺一个键在界面上就是一句看不懂的话，所以逐个文件比对。
    const reference = Object.keys(readPool('en')).sort();
    expect(reference.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      expect({ locale, keys: Object.keys(readPool(locale)).sort() }).toEqual({
        locale,
        keys: reference,
      });
    }
  });

  test('no locale leaves a value blank', () => {
    for (const locale of LOCALES) {
      const blank = Object.entries(readPool(locale))
        .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
        .map(([key]) => key);
      expect({ locale, blank }).toEqual({ locale, blank: [] });
    }
  });
});

describe('channel block exit', () => {
  const block = (ids: number[]): SupplyKindConfig => ({
    enabled: true,
    natures: ['api'],
    connections: Object.fromEntries(
      ids.map((id, index) => [
        index === 0 ? 'api' : 'web',
        {
          endpoint: '',
          account: '',
          secret: '',
          secretPresent: true,
          domain: '',
          clientId: '',
          egressId: id,
        },
      ])
    ),
  });

  test('reports the shared id when every connection agrees', () => {
    expect(blockEgressId(block([4]))).toBe(4);
    expect(blockEgressId(block([4, 4]))).toBe(4);
  });

  test('reports none when connections disagree, instead of picking one', () => {
    // 一个下拉框只能表达一个值；报其中任意一个都会盖掉另一个连接的真实出口。
    expect(blockEgressId(block([4, 5]))).toBe(0);
  });

  test('reports none for a missing block', () => {
    expect(blockEgressId(null)).toBe(0);
    expect(blockEgressId(undefined)).toBe(0);
  });
});
