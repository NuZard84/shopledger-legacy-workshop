'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// These modules depend on config and pure domain helpers. They do not import lib/store
// or load application data, so every scenario below uses only in-memory order fixtures.
const pricing = require('../lib/pricing');
const tax = require('../lib/tax');
const invoice = require('../lib/invoice');
const reports = require('../lib/reports');

test('billing and invoice agree for an undiscounted item using the default GST rate', function () {
  const items = [{ id: 1, name: 'Tea', sku: 'TEA-1', hsn: '0902', price: 100, qty: 1 }];

  assert.deepEqual(pricing.computeTotals(items, ''), {
    subtotal: 100,
    discount: 0,
    taxable: 100,
    tax: 18,
    cgst: 9,
    sgst: 9,
    total: 118,
    lines: [{
      id: 1,
      name: 'Tea',
      hsn: '0902',
      gstPercent: 18,
      gross: 100,
      discount: 0,
      taxable: 100,
      tax: 18,
      net: 118
    }]
  });
  assert.deepEqual(invoice.computeInvoiceFigures({ items, coupon: '' }), {
    subtotal: 100,
    discount: 0,
    tax: 18,
    cgst: 9,
    sgst: 9,
    total: 118,
    rows: [{
      name: 'Tea', sku: 'TEA-1', hsn: '0902', qty: 1, price: 100,
      gstPercent: 18, line: 100, lineTax: 18
    }]
  });
});

test('pricing and invoice both round displayed line tax to currency precision', function () {
  const items = [{ id: 1, name: 'Small item', price: 0.05, qty: 1 }];

  assert.equal(pricing.computeTotals(items, '').tax, 0.01);
  assert.equal(invoice.computeInvoiceFigures({ items }).tax, 0.01);
  assert.deepEqual(tax.splitCgstSgst(0.01), { cgst: 0.01, sgst: 0 });
  assert.deepEqual(invoice.computeInvoiceFigures({ items }), {
    subtotal: 0.05,
    discount: 0,
    tax: 0.01,
    cgst: 0.01,
    sgst: 0,
    total: 0.06,
    rows: [{
      name: 'Small item', sku: '-', hsn: '-', qty: 1, price: 0.05,
      gstPercent: 18, line: 0.05, lineTax: 0.01
    }]
  });
});

test('invoice figures match the billed HSN tax, coupon discount, and total', function () {
  const items = [{ id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 600, qty: 1 }];
  const billed = pricing.computeTotals(items, 'SAVE10');
  const invoiced = invoice.computeInvoiceFigures({ items, coupon: 'SAVE10' });

  assert.equal(invoiced.subtotal, billed.subtotal);
  assert.equal(invoiced.discount, billed.discount);
  assert.equal(invoiced.tax, billed.tax);
  assert.equal(invoiced.cgst, billed.cgst);
  assert.equal(invoiced.sgst, billed.sgst);
  assert.equal(invoiced.total, billed.total);
  assert.deepEqual(invoiced.rows.map(function (row) { return row.gstPercent; }), [5]);
});

test('invoice applies configured HSN slabs and defaults unknown HSN values', function () {
  const items = [
    { id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 100, qty: 1 },
    { id: 2, name: 'Unknown HSN', sku: 'MISC', hsn: '9999', price: 100, qty: 1 }
  ];
  const billed = pricing.computeTotals(items, '');
  const invoiced = invoice.computeInvoiceFigures({ items, coupon: '' });

  assert.equal(billed.tax, 23);
  assert.equal(billed.total, 223);
  assert.equal(invoiced.tax, 23);
  assert.equal(invoiced.total, 223);
  assert.deepEqual(invoiced.rows.map(function (row) { return row.gstPercent; }), [5, 18]);
});

test('invoice applies SAVE10 to the same subtotal basis as billing', function () {
  const items = [{ id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 600, qty: 1 }];
  const billed = pricing.computeTotals(items, 'SAVE10');
  const invoiced = invoice.computeInvoiceFigures({ items, coupon: 'SAVE10' });

  assert.equal(billed.discount, 60);
  assert.equal(billed.tax, 27);
  assert.equal(billed.total, 567);
  assert.equal(invoiced.discount, 60);
  assert.equal(invoiced.tax, 27);
  assert.equal(invoiced.total, 567);
});

test('invoice interprets fractional gstRate using the billing tax rules', function () {
  const items = [{ id: 1, name: 'Rice', hsn: '1006', gstRate: 0.05, price: 100, qty: 1 }];
  const billed = pricing.computeTotals(items, '');
  const invoiced = invoice.computeInvoiceFigures({ items });

  assert.equal(billed.tax, 5);
  assert.equal(billed.total, 105);
  assert.equal(invoiced.tax, 5);
  assert.equal(invoiced.total, 105);
});

test('reconciliation matches invoice figures with stored billed totals', function () {
  const items = [{ id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 600, qty: 1 }];
  const billed = pricing.computeTotals(items, 'SAVE10');
  const order = {
    id: 1001,
    date: '22/11/2026',
    customer: 'Counter customer',
    coupon: 'SAVE10',
    status: 'completed',
    items,
    subtotal: billed.subtotal,
    discount: billed.discount,
    tax: billed.tax,
    total: billed.total
  };

  const result = reports.getGstReconciliation({ orders: [order] });

  assert.equal(result.totalChecked, 1);
  assert.equal(result.mismatchCount, 0);
  assert.equal(result.totalDelta, 0);
  assert.deepEqual(result.rows[0], {
    orderId: 1001,
    date: '22/11/2026',
    customer: 'Counter customer',
    coupon: 'SAVE10',
    ledgerSubtotal: 600,
    ledgerDiscount: 60,
    ledgerTax: 27,
    ledgerTotal: 567,
    invoiceDiscount: 60,
    invoiceTax: 27,
    invoiceTotal: 567,
    delta: 0,
    matched: true
  });

  const html = invoice.render(order);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice with no items returns a zero total', function () {
  assert.deepEqual(invoice.computeInvoiceFigures({}), {
    subtotal: 0,
    discount: 0,
    tax: 0,
    cgst: 0,
    sgst: 0,
    total: 0,
    rows: []
  });
});
