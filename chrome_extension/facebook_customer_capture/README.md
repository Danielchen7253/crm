# Coolfix CRM Customer Capture

Local Chrome/Edge extension for scanning visible/loadable Facebook, Messenger, and Marketplace customers into the CRM.

## Install locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on Developer mode.
3. Click `Load unpacked`.
4. Select this folder: `chrome_extension/facebook_customer_capture`.

## Use

- Open Facebook, Messenger, or Marketplace.
- Click the extension.
- Use `Scan all customers` on a customer inbox/list page to build a local queue.
- Use `Import queue` to send the queued customers to CRM in batches.
- Use `Stop`, `Pause import`, and `Resume import` to control long runs.
- Use `Save current customer` on a customer conversation/profile page.

This extension does not store Facebook passwords, cookies, or send messages. It only sends visible customer information to the CRM capture endpoint.
