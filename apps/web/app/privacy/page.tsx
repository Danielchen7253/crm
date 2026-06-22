import "../compliance.css";

export default function PrivacyPage() {
  return (
    <main className="compliancePage">
      <div className="complianceWrap">
        <header className="complianceHeader">
          <p>CoolFix Pro Supply</p>
          <h1>Privacy Policy</h1>
          <p>Last updated: June 22, 2026</p>
        </header>

        <section className="complianceText">
          <p>
            CoolFix Pro Supply collects customer information to answer product
            questions, prepare quotes, process orders, coordinate pickup and
            shipping, and provide customer support for HVAC and refrigeration
            parts.
          </p>

          <h2>Information we collect</h2>
          <ul>
            <li>Name, phone number, email address, and company name</li>
            <li>Messages, call details, support requests, and order questions</li>
            <li>Product models, photos, quantities, and service needs</li>
            <li>Shipping, pickup, invoice, and payment-support information</li>
          </ul>

          <h2>How we use information</h2>
          <ul>
            <li>To respond to customer inquiries</li>
            <li>To send quotes, pickup details, and shipping updates</li>
            <li>To provide order and customer support</li>
            <li>To maintain customer records in our CRM</li>
            <li>To improve service quality and follow-up reminders</li>
          </ul>

          <h2>SMS privacy</h2>
          <p>
            SMS opt-in data and consent are used only to send messages from
            CoolFix Pro Supply related to customer requests, orders, quotes,
            pickup, shipping, or support. SMS opt-in consent and phone numbers
            are not sold, rented, or shared with third parties for their
            marketing purposes.
          </p>

          <h2>Sharing</h2>
          <p>
            We do not sell customer personal information. We may share limited
            information with service providers that help us operate our website,
            CRM, messaging, shipping, payment, or customer-support systems.
          </p>

          <h2>Contact</h2>
          <p>
            For privacy questions, contact CoolFix Pro Supply at
            danielchen7253@gmail.com.
          </p>
        </section>

        <footer className="complianceFooter">
          <a href="/sms-consent">SMS Consent</a>
          <a href="/terms">Terms and Conditions</a>
        </footer>
      </div>
    </main>
  );
}
