# IBKR Flex Query Setup

The IBKR importer pulls data from the **IBKR Flex Web Service** (no file upload). You need a Flex token and a Flex Query ID configured in the importer settings.

## 1. Create a Flex Token

1. Log in to IBKR Client Portal
2. Go to **Reports → Flex Queries**
3. In the top-right, click **Create** next to **Flex Web Service Token**
4. Copy the generated token — it is only shown once

## 2. Create a Flex Query

1. In **Reports → Flex Queries**, click **Create** next to **Activity Flex Query**
2. Give it a name (e.g. "family-ledger")
3. Set the **Date Period**: choose **Last 365 Calendar Days** (or any period covering your import range)
4. Enable the following sections and fields:

---

### Trades

Required for stock buys/sells and forex conversions.

Enable the section. Under **Delivery Configuration**, include at minimum:

| Field | Notes |
|-------|-------|
| Asset Category | Distinguishes stocks from forex |
| Symbol | Ticker (VTI, USD.CHF, etc.) |
| Currency | Trade currency |
| Buy/Sell | Direction |
| Quantity | Number of shares or currency units |
| Trade Price | Execution price |
| Trade Money | Gross cash amount |
| IB Commission | Commission charged |
| IB Commission Currency | Currency of commission |
| Cost Basis | Used for lot-level cost on sells |
| FIFO P&L Realized | Realized gain/loss per lot |
| Trade Date | Settlement date used for the transaction |
| Report Date | Fallback if Trade Date is absent |
| Transaction ID | Deduplication key |
| IB Order ID | Groups partial fills into one transaction |

---

### Cash Transactions

Required for dividends, withholding taxes, interest, fees, and deposits/withdrawals.

Enable the section. Include at minimum:

| Field | Notes |
|-------|-------|
| Type | Dividend, Withholding Tax, Interest, Fees, Deposits & Withdrawals |
| Symbol | Security ticker (for dividends/withholding) |
| Currency | Transaction currency |
| Amount | Signed cash amount |
| Report Date | Date used for the transaction |
| Transaction ID | Deduplication key |
| Description | Used as the transaction narration |

---

### Open Positions

Required for stock balance assertions at end of period.

Enable the section. Set **Level of Detail** to either **Summary** (preferred — one row per symbol) or **Lot** (the importer aggregates automatically).

Include at minimum:

| Field | Notes |
|-------|-------|
| Symbol | Ticker |
| Position | Total quantity held |
| Currency | Position currency |

---

### Cash Report

Required for cash balance assertions at end of period.

Enable the section. Set **Level of Detail** to **Currency Summary**.

Include at minimum:

| Field | Notes |
|-------|-------|
| Currency | Cash currency (USD, CHF, etc.) |
| Ending Cash | Balance at end of period |

---

## 3. Configure the Importer

In the family-ledger importer settings, provide:

```json
{
  "token": "<your Flex Web Service token>",
  "query_id": "<numeric Flex Query ID>",
  "cash_accounts": {
    "USD": "accounts/ibkr-depot-usd",
    "CHF": "accounts/ibkr-depot-chf"
  },
  "stock_accounts": {
    "VTI":  "accounts/ibkr-shares-vti",
    "VSGX": "accounts/ibkr-shares-vsgx"
  },
  "dividend_accounts": {
    "VTI":  "accounts/dividends-ibkr-vti",
    "VSGX": "accounts/dividends-ibkr-vsgx"
  },
  "commissions_account":    "accounts/commissions-ibkr",
  "fees_account":           "accounts/fees-ibkr",
  "profit_loss_account":    "accounts/profitloss-ibkr",
  "interest_account":       "accounts/interests-ibkr",
  "withholding_tax_account":"accounts/uswithholding",
  "transfer_account":       "accounts/ibkr-transfers"
}
```

Add one entry to `stock_accounts` and `dividend_accounts` for each ticker you hold. If a ticker appears in the statement but has no mapping, the importer will warn and skip those transactions — add the mapping and re-import; already-imported transactions deduplicate automatically.

## 4. Notes

- The Flex Query ID is the numeric ID shown in the query list (not the query name).
- The importer retries up to ~30 seconds if IBKR returns "Processing" while generating the report.
- Balance assertions are created for `toDate + 1 day` (the day after the statement period ends), which is Beancount convention.
- Partial fills of the same order (same IB Order ID) are merged into one transaction, both for buys and sells.
