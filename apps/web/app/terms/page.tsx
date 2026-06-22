import "../compliance.css";

export default function TermsPage() {
  return (
    <main className="compliancePage">
      <div className="complianceWrap">
        <header className="complianceHeader">
          <p>CoolFix Pro Supply</p>
          <h1>Terms and Conditions</h1>
          <p>Last updated: June 22, 2026</p>
        </header>

        <section className="complianceText">
          <p>
            These terms apply to communications and services provided by CoolFix
            Pro Supply, including website chat, phone, SMS/MMS, email, and
            customer support.
          </p>

          <h2>Messaging terms</h2>
          <p>
            By providing your phone number and agreeing to receive text messages
            from CoolFix Pro Supply, you agree to receive conversational,
            customer-support, quote, order, pickup, shipping, and service
            messages. Message frequency varies. Message and data rates may
            apply. Reply STOP to opt out. Reply HELP for help. Consent is not a
            condition of purchase.
          </p>

          <h2>Opt out</h2>
          <p>
            You may opt out of SMS/MMS messages at any time by replying STOP.
            After opting out, you may still contact CoolFix Pro Supply by phone,
            email, website chat, or other available channels.
          </p>

          <h2>Support</h2>
          <p>
            Reply HELP for SMS assistance or contact CoolFix Pro Supply at
            danielchen7253@gmail.com.
          </p>

          <h2>Product information</h2>
          <p>
            Product availability, prices, shipping time, pickup time, and
            technical compatibility may change. CoolFix Pro Supply confirms these
            details before final sale or fulfillment.
          </p>
        </section>

        <footer className="complianceFooter">
          <a href="/sms-consent">SMS Consent</a>
          <a href="/privacy">Privacy Policy</a>
        </footer>
      </div>
    </main>
  );
}
