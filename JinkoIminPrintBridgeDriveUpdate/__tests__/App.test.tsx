/**
 * @format
 */

import App from '../App';

// Note: import explicitly to use the types shiped with jest.
import {expect, it} from '@jest/globals';

it('exports the print bridge app', () => {
  expect(App).toBeDefined();
});
