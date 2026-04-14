"""
services/email_service.py
Async email sending service using aiosmtplib.
Sends a professionally styled HTML verification email with a 6-digit code.
"""

import os
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import aiosmtplib
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# SMTP configuration (loaded from .env)
# ---------------------------------------------------------------------------

SMTP_HOST: str = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT: int = int(os.getenv("SMTP_PORT", "587"))
SMTP_SECURE: bool = os.getenv("SMTP_SECURE", "false").lower() == "true"
SMTP_USER: str = os.getenv("SMTP_USER", "")
SMTP_PASS: str = os.getenv("SMTP_PASS", "")
SMTP_FROM: str = os.getenv("SMTP_FROM", "Messenger <no-reply@messenger.app>")


# ---------------------------------------------------------------------------
# HTML template builder
# ---------------------------------------------------------------------------


def _build_html(code: str) -> str:
    """
    Returns a dark-themed HTML email containing the 6-digit verification code.
    Compatible with most modern email clients.
    """
    year = datetime.utcnow().year
    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Подтверждение почты</title>
</head>
<body style="
  margin: 0;
  padding: 0;
  background-color: #0f0f13;
  font-family: 'Segoe UI', Arial, sans-serif;
">
  <table width="100%" cellpadding="0" cellspacing="0"
         style="background-color: #0f0f13; padding: 48px 16px;">
    <tr>
      <td align="center">

        <!-- Card -->
        <table width="100%" cellpadding="0" cellspacing="0" style="
          max-width: 480px;
          background-color: #1a1a24;
          border-radius: 16px;
          border: 1px solid #2a2a3a;
          overflow: hidden;
        ">

          <!-- Header -->
          <tr>
            <td style="
              background: linear-gradient(135deg, #7c5cbf 0%, #5e3fa3 100%);
              padding: 32px 40px;
              text-align: center;
            ">
              <div style="
                font-size: 28px;
                font-weight: 700;
                color: #ffffff;
                letter-spacing: -0.5px;
              ">&#128172; Messenger</div>
              <div style="
                margin-top: 6px;
                font-size: 14px;
                color: rgba(255,255,255,0.8);
                letter-spacing: 0.5px;
              ">Подтверждение электронной почты</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 40px;">

              <p style="
                margin: 0 0 8px 0;
                font-size: 16px;
                color: #a0a0b8;
                text-align: center;
              ">
                Используйте код ниже для подтверждения вашего адреса электронной почты.
              </p>

              <p style="
                margin: 0 0 32px 0;
                font-size: 13px;
                color: #606078;
                text-align: center;
              ">
                Никому не сообщайте этот код.
              </p>

              <!-- Code box -->
              <div style="
                background-color: #12121c;
                border: 2px solid #7c5cbf;
                border-radius: 12px;
                padding: 28px 16px;
                text-align: center;
                margin-bottom: 32px;
              ">
                <div style="
                  font-size: 48px;
                  font-weight: 800;
                  letter-spacing: 14px;
                  color: #ffffff;
                  font-family: 'Courier New', Courier, monospace;
                  text-indent: 14px;
                ">{code}</div>
              </div>

              <!-- Expiry notice -->
              <div style="
                background-color: rgba(124, 92, 191, 0.1);
                border: 1px solid rgba(124, 92, 191, 0.3);
                border-radius: 8px;
                padding: 14px 18px;
                margin-bottom: 32px;
              ">
                <table cellpadding="0" cellspacing="0" width="100%">
                  <tr>
                    <td style="width: 28px; vertical-align: top;">
                      <span style="font-size: 18px;">&#9200;</span>
                    </td>
                    <td style="vertical-align: top;">
                      <span style="font-size: 13px; color: #a0a0b8; line-height: 1.6;">
                        Этот код действителен в течение
                        <strong style="color: #ffffff;">10 минут</strong>.
                        Если он истечёт, запросите новый на странице регистрации.
                      </span>
                    </td>
                  </tr>
                </table>
              </div>

              <!-- Disclaimer -->
              <p style="
                margin: 0;
                font-size: 12px;
                color: #606078;
                text-align: center;
                line-height: 1.7;
              ">
                Если вы не создавали аккаунт в Messenger, просто проигнорируйте
                это письмо.<br/>Без подтверждения аккаунт активирован не будет.
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="
              background-color: #12121c;
              border-top: 1px solid #2a2a3a;
              padding: 20px 40px;
              text-align: center;
            ">
              <p style="
                margin: 0;
                font-size: 11px;
                color: #404058;
                line-height: 1.6;
              ">
                &copy; {year} Messenger. Все права защищены.<br/>
                Это автоматическое сообщение &#8212; пожалуйста, не отвечайте на него.
              </p>
            </td>
          </tr>

        </table>
        <!-- /Card -->

      </td>
    </tr>
  </table>
</body>
</html>"""


def _build_plain(code: str) -> str:
    """Plain-text fallback for email clients that don't render HTML."""
    return (
        "Messenger — Подтверждение почты\n"
        "\n"
        f"Ваш код подтверждения: {code}\n"
        "\n"
        "Код действителен в течение 10 минут.\n"
        "\n"
        "Если вы не регистрировались в Messenger, проигнорируйте это письмо."
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def send_verification_email(to_email: str, code: str) -> None:
    """
    Send a verification email with a 6-digit code to *to_email*.

    Uses SMTP credentials from environment variables.  Supports both
    plain STARTTLS (port 587) and implicit TLS (port 465) connections.

    Args:
        to_email: Recipient email address.
        code:     6-digit verification code string.

    Raises:
        aiosmtplib.SMTPException: If the email could not be sent.
    """
    # Build the MIME message
    message = MIMEMultipart("alternative")
    message["From"] = SMTP_FROM
    message["To"] = to_email
    message["Subject"] = f"{code} — ваш код подтверждения Messenger"

    # Attach plain-text first (fallback), then HTML (preferred)
    message.attach(MIMEText(_build_plain(code), "plain", "utf-8"))
    message.attach(MIMEText(_build_html(code), "html", "utf-8"))

    # Choose connection strategy based on SMTP_SECURE flag:
    #   SMTP_SECURE=true  → implicit TLS from the start (port 465)
    #   SMTP_SECURE=false → plain connection + STARTTLS upgrade (port 587)
    await aiosmtplib.send(
        message,
        hostname=SMTP_HOST,
        port=SMTP_PORT,
        username=SMTP_USER,
        password=SMTP_PASS,
        use_tls=SMTP_SECURE,  # implicit TLS (port 465)
        start_tls=not SMTP_SECURE,  # STARTTLS upgrade (port 587)
    )
