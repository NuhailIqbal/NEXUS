import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { isSameDay } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  SortableColumnHeader, TableTextFilter, TableSelectFilter, TableDateFilter, TablePagination,
} from "@/components/dashboard/table/TableControls";
import { api } from "@/services/api";
import { PurchaseTxn, TXN_LABELS } from "./types";

type TxnColumnKey = "created_at" | "kind" | "description" | "amount" | "balance_after";

const TXN_COLUMNS: { key: TxnColumnKey; label: string }[] = [
  { key: "created_at", label: "Date" },
  { key: "kind", label: "Type" },
  { key: "description", label: "Description" },
  { key: "amount", label: "Amount" },
  { key: "balance_after", label: "Balance After" },
];

function txnTextFor(t: PurchaseTxn, key: TxnColumnKey): string {
  if (key === "kind") return TXN_LABELS[t.kind] || t.kind;
  if (key === "description") return t.description || "";
  if (key === "amount") return String(t.amount);
  if (key === "balance_after") return t.balance_after != null ? String(t.balance_after) : "";
  return t.created_at;
}

const Transactions = () => {
  const [transactions, setTransactions] = useState<PurchaseTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [txnSortKey, setTxnSortKey] = useState<TxnColumnKey | null>(null);
  const [txnSortDir, setTxnSortDir] = useState<"asc" | "desc">("asc");
  const [txnFilters, setTxnFilters] = useState<Record<TxnColumnKey, string>>({
    created_at: "", kind: "", description: "", amount: "", balance_after: "",
  });
  const [txnDateFilter, setTxnDateFilter] = useState<Date | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    api.getWalletTransactions().then(({ data }) => {
      if (Array.isArray(data)) setTransactions(data);
      setLoading(false);
    });
  }, []);

  const toggleTxnSort = (key: TxnColumnKey) => {
    if (txnSortKey !== key) { setTxnSortKey(key); setTxnSortDir("asc"); return; }
    if (txnSortDir === "asc") { setTxnSortDir("desc"); return; }
    setTxnSortKey(null);
  };

  const setTxnFilter = (key: TxnColumnKey, value: string) =>
    setTxnFilters((f) => ({ ...f, [key]: value }));

  const txnKindOptions = useMemo(() => {
    const set = new Set(transactions.map((t) => t.kind).filter(Boolean));
    return Array.from(set).sort();
  }, [transactions]);

  const filteredTransactions = useMemo(() => {
    return transactions.filter((t) =>
      TXN_COLUMNS.every(({ key }) => {
        if (key === "created_at") {
          if (!txnDateFilter) return true;
          const t2 = t.created_at ? new Date(t.created_at) : null;
          return !!t2 && !isNaN(t2.getTime()) && isSameDay(t2, txnDateFilter);
        }
        if (key === "kind") {
          if (!txnFilters.kind) return true;
          return t.kind === txnFilters.kind;
        }
        const q = txnFilters[key].trim().toLowerCase();
        return !q || txnTextFor(t, key).toLowerCase().includes(q);
      })
    );
  }, [transactions, txnFilters, txnDateFilter]);

  const sortedTransactions = useMemo(() => {
    if (!txnSortKey) return filteredTransactions;
    return [...filteredTransactions].sort((a, b) => {
      if (txnSortKey === "amount" || txnSortKey === "balance_after") {
        const av = txnSortKey === "amount" ? a.amount : a.balance_after ?? 0;
        const bv = txnSortKey === "amount" ? b.amount : b.balance_after ?? 0;
        return txnSortDir === "asc" ? av - bv : bv - av;
      }
      if (txnSortKey === "created_at") {
        const av = new Date(a.created_at).getTime();
        const bv = new Date(b.created_at).getTime();
        return txnSortDir === "asc" ? av - bv : bv - av;
      }
      const av = txnTextFor(a, txnSortKey).toLowerCase();
      const bv = txnTextFor(b, txnSortKey).toLowerCase();
      if (av < bv) return txnSortDir === "asc" ? -1 : 1;
      if (av > bv) return txnSortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [filteredTransactions, txnSortKey, txnSortDir]);

  // Filters/sort/page-size changed — jump back to page 1 so a filter never
  // leaves the user stranded on a now-empty page.
  useEffect(() => { setPage(1); }, [txnFilters, txnDateFilter, txnSortKey, txnSortDir, pageSize]);

  const totalPages = Math.max(1, Math.ceil(sortedTransactions.length / pageSize));
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  const visibleTransactions = useMemo(
    () => sortedTransactions.slice((page - 1) * pageSize, page * pageSize),
    [sortedTransactions, page, pageSize]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading transactions...
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No transactions yet.
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold text-foreground">Purchase History</h2>
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <tr className="divide-x divide-border">
                {TXN_COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3 text-center">
                    <SortableColumnHeader
                      label={label}
                      active={txnSortKey === key}
                      dir={txnSortDir}
                      onClick={() => toggleTxnSort(key)}
                    />
                  </th>
                ))}
              </tr>
              <tr className="divide-x divide-border border-t border-border">
                {TXN_COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3 font-normal normal-case">
                    {key === "created_at" ? (
                      <TableDateFilter value={txnDateFilter} onChange={setTxnDateFilter} />
                    ) : key === "kind" ? (
                      <TableSelectFilter
                        value={txnFilters.kind}
                        onChange={(v) => setTxnFilter("kind", v)}
                        placeholder="Type"
                        options={txnKindOptions.map((k) => ({ value: k, label: TXN_LABELS[k] || k }))}
                      />
                    ) : (
                      <TableTextFilter value={txnFilters[key]} onChange={(v) => setTxnFilter(key, v)} placeholder={label} />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleTransactions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No transactions match your filters.
                  </td>
                </tr>
              ) : (
                visibleTransactions.map((t) => {
                  const credit = t.amount >= 0;
                  return (
                    <tr key={t.id} className="divide-x divide-border border-t border-border bg-card/30">
                      <td className="px-4 py-3 text-center text-foreground">
                        {new Date(t.created_at).toLocaleDateString()}{" "}
                        <span className="text-xs text-muted-foreground">
                          {new Date(t.created_at).toLocaleTimeString()}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Badge variant="outline" className="whitespace-nowrap">{TXN_LABELS[t.kind] || t.kind}</Badge>
                      </td>
                      <td className="px-4 py-3 text-center text-muted-foreground">{t.description || "—"}</td>
                      <td className={`px-4 py-3 text-center font-medium ${credit ? "text-green-500" : "text-destructive"}`}>
                        {credit ? "+" : "-"}${Math.abs(t.amount).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-center text-foreground">
                        {t.balance_after != null ? `$${t.balance_after.toFixed(2)}` : "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <TablePagination
          page={page}
          pageSize={pageSize}
          totalCount={sortedTransactions.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>
    </div>
  );
};

export default Transactions;
