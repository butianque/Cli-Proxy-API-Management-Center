import { describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse as parseYaml } from 'yaml';
import { useVisualConfig } from '../src/hooks/useVisualConfig';

describe('visual config concurrency', () => {
  test('only applies dirty visual fields to the latest server YAML', () => {
    function Harness() {
      const visualConfig = useVisualConfig();
      const [phase, setPhase] = useState(0);

      if (phase === 0) {
        visualConfig.loadVisualValuesFromYaml(
          'routing:\n  retry:\n    request-retry: 3\nobservability:\n  logs:\n    debug: false\n'
        );
        setPhase(1);
      } else if (phase === 1) {
        visualConfig.setVisualValues({ requestRetry: '7' });
        setPhase(2);
      } else {
        return createElement(
          'pre',
          null,
          visualConfig.applyVisualChangesToYaml(
            'routing:\n  retry:\n    request-retry: 3\nobservability:\n  logs:\n    debug: true\n'
          )
        );
      }

      return null;
    }

    const markup = renderToStaticMarkup(createElement(Harness));
    const merged = markup.slice('<pre>'.length, -'</pre>'.length);

    expect(parseYaml(merged)).toEqual({
      observability: { logs: { debug: true } },
      routing: { retry: { 'request-retry': 7 } },
    });
  });
});
