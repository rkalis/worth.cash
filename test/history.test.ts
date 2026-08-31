import { snapshotTimestampFromUtcInput, toUtcDateInputValue } from 'lib/history/snapshot';
import { describe, expect, it } from 'vitest';

describe('snapshotTimestampFromUtcInput', () => {
  // The fields are labelled UTC, so they have to be read as UTC. `new Date('2026-08-22T09:00')` would be
  // read as local time, which is silently wrong by hours and can land on the wrong day.
  it('reads the fields as UTC rather than local time', () => {
    expect(snapshotTimestampFromUtcInput('2026-08-22', '09:00')).toBe(Date.UTC(2026, 7, 22, 9, 0));
  });

  it('handles midnight and the end of the day', () => {
    expect(snapshotTimestampFromUtcInput('2026-01-01', '00:00')).toBe(Date.UTC(2026, 0, 1, 0, 0));
    expect(snapshotTimestampFromUtcInput('2026-12-31', '23:59')).toBe(Date.UTC(2026, 11, 31, 23, 59));
  });

  it('returns null for an incomplete or unparseable input', () => {
    expect(snapshotTimestampFromUtcInput('', '09:00')).toBeNull();
    expect(snapshotTimestampFromUtcInput('2026-08-22', '')).toBeNull();
    expect(snapshotTimestampFromUtcInput('not-a-date', '09:00')).toBeNull();
  });

  it('round-trips through the date input value', () => {
    const timestamp = Date.UTC(2026, 7, 22, 9, 0);
    expect(snapshotTimestampFromUtcInput(toUtcDateInputValue(timestamp), '09:00')).toBe(timestamp);
  });
});

describe('toUtcDateInputValue', () => {
  it('formats a moment as the date input expects, in UTC', () => {
    expect(toUtcDateInputValue(Date.UTC(2026, 7, 22, 23, 30))).toBe('2026-08-22');
  });
});
