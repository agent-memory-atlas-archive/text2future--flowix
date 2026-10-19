import './csv-table-loading-skeleton.css';

/** Lightweight CSV grid preview used before the lazy CSV renderer is ready. */
export function CsvTableLoadingSkeleton() {
  const columns = Array.from({ length: 6 }, (_, index) => index);
  const rows = Array.from({ length: 10 }, (_, index) => index);
  const widths = [66, 42, 78, 55, 32, 62];
  return <section className="csv-table-loading-skeleton" aria-label="CSV 表格预览" aria-busy="true">
    <div className="csv-table-loading-skeleton__viewport" aria-hidden="true">
      <div className="csv-table-loading-skeleton__grid">
        <div className="csv-table-loading-skeleton__row csv-table-loading-skeleton__row--header">
          <div className="csv-table-loading-skeleton__index" />
          {columns.map((column) => <div key={column} className="csv-table-loading-skeleton__cell">
            <span className="csv-table-loading-skeleton__block" style={{ width: `${widths[column]}%` }} />
          </div>)}
        </div>
        {rows.map((row) => <div key={row} className="csv-table-loading-skeleton__row">
          <div className="csv-table-loading-skeleton__index">
            <span className="csv-table-loading-skeleton__block" style={{ width: '24%' }} />
          </div>
          {columns.map((column) => <div key={column} className="csv-table-loading-skeleton__cell">
            <span className="csv-table-loading-skeleton__block" style={{ width: `${widths[(row + column) % widths.length]}%` }} />
          </div>)}
        </div>)}
      </div>
    </div>
  </section>;
}
