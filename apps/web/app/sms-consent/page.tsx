import "../compliance.css";

export default function SmsConsentPage() {
  return (
    <main className="compliancePage">
      <div className="complianceWrap">
        <header className="complianceHeader">
          <p>CoolFix Pro Supply</p>
          <h1>SMS Consent and Opt-In Workflow</h1>
          <p>
            This page explains how customers give CoolFix Pro Supply permission
            to send SMS and MMS messages.
          </p>
        </header>

        <section className="complianceText">
          <div className="complianceBox">
            <strong>Company:</strong> CoolFix Pro Supply
            <br />
            <strong>Phone:</strong> +1 858 757 0488
            <br />
            <strong>Website:</strong> https://coolfixpro.com
            <br />
            <strong>Email:</strong> danielchen7253@gmail.com
          </div>

          <h2>How customers opt in</h2>
          <ol>
            <li>
              A customer contacts CoolFix Pro Supply first by phone, website
              chat, email, Facebook Messenger, WhatsApp, marketplace inquiry, or
              an in-person request about HVAC or refrigeration parts.
            </li>
            <li>
              When the customer asks for product availability, quote follow-up,
              pickup details, shipping updates, invoice information, or customer
              support, CoolFix Pro Supply asks for permission to follow up by
              text message.
            </li>
            <li>
              The customer gives active consent by providing their phone number
              and confirming that CoolFix Pro Supply may text them about their
              request, order, quote, pickup, shipping, or support case.
            </li>
            <li>
              After consent is received, CoolFix Pro Supply may send
              conversational and customer-support messages related to that
              customer request.
            </li>
          </ol>

          <h2>Required consent disclosure</h2>
          <p>
            By providing your phone number and agreeing to receive text messages
            from CoolFix Pro Supply, you agree to receive conversational,
            customer-support, quote, order, pickup, shipping, and service
            messages from CoolFix Pro Supply. Message frequency varies. Message
            and data rates may apply. Reply STOP to opt out. Reply HELP for
            help. Consent is not a condition of purchase.
          </p>

          <h2>Message types</h2>
          <ul>
            <li>Product availability and quote follow-up</li>
            <li>Pickup address and pickup-time coordination</li>
            <li>Shipping and order support</li>
            <li>Customer service follow-up</li>
            <li>Repair-service inquiry follow-up</li>
          </ul>

          <h2>Opt out and help</h2>
          <p>
            Customers may reply STOP at any time to stop receiving SMS/MMS
            messages. Customers may reply HELP for assistance. CoolFix Pro Supply
            will honor opt-out requests and will not continue sending messages
            to opted-out customers.
          </p>

          <h2>Data sharing</h2>
          <p>
            SMS opt-in data and consent are used only by CoolFix Pro Supply to
            communicate with customers. SMS opt-in consent and phone numbers are
            not sold, rented, or shared with third parties for their marketing.
          </p>
        </section>

        <footer className="complianceFooter">
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms and Conditions</a>
        </footer>
      </div>
    </main>
  );
}
