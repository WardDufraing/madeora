/**
 * The downloadable security report (S38, spec "Confirmed downloadable adult security activity
 * report"): CSV and JSON built from the rows `security_report_rows` returns. Labels are Madeora's
 * own words in the reader's language; the only user-typed value is a Home's name, which is
 * neutralised against spreadsheet formula injection in the CSV. No IP address, location, secret
 * or identifier is ever part of a row. Client-safe and pure.
 */
export interface ReportRow {
  readonly kind: string;
  readonly outcome: string;
  readonly homeName: string | null;
  readonly device: string | null;
  readonly createdAt: string;
}

export interface ReportMeta {
  readonly from: string;
  readonly to: string;
  readonly timeZone: string;
  readonly snapshotAt: string;
  readonly generatedAt: string;
}

export interface ReportLabels {
  readonly event: (kind: string) => string;
  readonly outcome: (outcome: string) => string;
  readonly columns: {
    readonly time: string;
    readonly event: string;
    readonly outcome: string;
    readonly device: string;
    readonly home: string;
  };
  /** The human-readable explanation: what is included, what is left out, the timezone. */
  readonly notes: readonly string[];
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** "2026-11-07 10:52:44 +01:00": the instant as wall-clock time in `timeZone`, with its offset. */
export function zonedTimestamp(instant: string, timeZone: string): string {
  const date = new Date(instant);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const wall = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  const offsetMinutes = Math.round((wall - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return (
    `${pad(value("year"), 4)}-${pad(value("month"))}-${pad(value("day"))} ` +
    `${pad(value("hour"))}:${pad(value("minute"))}:${pad(value("second"))} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * One CSV cell: quoted when needed, and a value that a spreadsheet would run as a formula
 * (starting with =, +, -, @, tab or carriage return) is prefixed with an apostrophe.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function buildCsv(
  rows: readonly ReportRow[],
  meta: ReportMeta,
  labels: ReportLabels,
): string {
  const header = [
    labels.columns.time,
    labels.columns.event,
    labels.columns.outcome,
    labels.columns.device,
    labels.columns.home,
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(
      [
        zonedTimestamp(row.createdAt, meta.timeZone),
        labels.event(row.kind),
        labels.outcome(row.outcome),
        row.device ?? "",
        row.homeName ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // A byte-order mark so spreadsheet programs read the file as UTF-8; CRLF per RFC 4180.
  return `\u{FEFF}${lines.join("\r\n")}\r\n`;
}

export function buildJson(
  rows: readonly ReportRow[],
  meta: ReportMeta,
  labels: ReportLabels,
): string {
  return `${JSON.stringify(
    {
      report: {
        type: "madeora-security-activity",
        version: 1,
        timeZone: meta.timeZone,
        from: meta.from,
        to: meta.to,
        snapshotAt: zonedTimestamp(meta.snapshotAt, meta.timeZone),
        generatedAt: zonedTimestamp(meta.generatedAt, meta.timeZone),
        notes: labels.notes,
      },
      events: rows.map((row) => ({
        time: zonedTimestamp(row.createdAt, meta.timeZone),
        event: row.kind,
        description: labels.event(row.kind),
        outcome: row.outcome,
        device: row.device,
        home: row.homeName,
      })),
    },
    null,
    2,
  )}\n`;
}

/** "madeora-security-report-2026-10-08-to-2026-11-07.csv" */
export function reportFileName(
  meta: Pick<ReportMeta, "from" | "to">,
  format: "csv" | "json",
): string {
  return `madeora-security-report-${meta.from}-to-${meta.to}.${format}`;
}
