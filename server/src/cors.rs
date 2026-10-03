//! CORS opt-in for hosted-UI mode (v0.1.1).
//!
//! The editor UI may be served from static hosting (e.g. Netlify) while the
//! engine runs LOCALLY in the `ove-web` binary. A cross-origin page can only
//! call this server when the operator EXPLICITLY allows the page's origin via
//! `OVE_WEB_ALLOW_ORIGIN` (comma-separated exact origins, or `*`).
//!
//! Default behavior is unchanged: unset/empty ⇒ no CORS headers at all
//! (same-origin only), byte-identical to v0.1.0.
//!
//! Private Network Access: when the page is public (https://…netlify.app) and
//! the server is on the operator's loopback, Chromium sends a preflight with
//! `Access-Control-Request-Private-Network: true`. We answer
//! `Access-Control-Allow-Private-Network: true` — but ONLY when the origin is
//! already allow-listed, so the opt-in remains the single gate.

use axum::extract::Request;
use axum::http::header::{self, HeaderName, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use std::sync::Arc;

/// Parse the `OVE_WEB_ALLOW_ORIGIN` value into an allowlist.
/// `None`/empty/whitespace ⇒ empty vec (CORS fully off).
/// `*` ⇒ wildcard. Otherwise comma-separated exact origins (trailing `/`
/// stripped for forgiveness).
pub fn parse_allow_origins(raw: Option<&str>) -> Vec<String> {
    match raw {
        None => Vec::new(),
        Some(v) => v
            .split(',')
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .collect(),
    }
}

fn is_allowed(allowed: &[String], origin: &str) -> bool {
    !origin.is_empty() && allowed.iter().any(|a| a == "*" || a == origin)
}

fn header_name(name: &'static str) -> HeaderName {
    HeaderName::from_static(name)
}

/// Wrap the app router with the CORS middleware. An empty allowlist returns
/// the router untouched (zero behavioral change — the default).
pub fn protect(app: Router, allowed: Vec<String>) -> Router {
    if allowed.is_empty() {
        return app;
    }
    let allowed = Arc::new(allowed);
    app.layer(axum::middleware::from_fn(
        move |req: Request, next: Next| {
            // Clone per call: the closure must stay FnMut (E0525) — moving
            // the Arc into the async block would consume it on first use.
            let allowed = Arc::clone(&allowed);
            async move {
                let origin = req
                    .headers()
                    .get(header::ORIGIN)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let is_preflight = req.method() == Method::OPTIONS;
                let pna_requested = req
                    .headers()
                    .get("access-control-request-private-network")
                    .and_then(|v| v.to_str().ok())
                    == Some("true");

                // Preflight never reaches routes (axum would 405 OPTIONS).
                let mut res: Response = if is_preflight {
                    StatusCode::OK.into_response()
                } else {
                    next.run(req).await
                };

                if is_allowed(&allowed, &origin) {
                    let headers = res.headers_mut();
                    if let Ok(v) = HeaderValue::from_str(&origin) {
                        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
                    }
                    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
                    if is_preflight {
                        headers.insert(
                            header::ACCESS_CONTROL_ALLOW_METHODS,
                            HeaderValue::from_static("GET, POST, OPTIONS"),
                        );
                        headers.insert(
                            header::ACCESS_CONTROL_ALLOW_HEADERS,
                            HeaderValue::from_static("content-type"),
                        );
                        headers.insert(
                            header::ACCESS_CONTROL_MAX_AGE,
                            HeaderValue::from_static("600"),
                        );
                        if pna_requested {
                            headers.insert(
                                header_name("access-control-allow-private-network"),
                                HeaderValue::from_static("true"),
                            );
                        }
                    }
                }
                res
            }
        },
    ))
}
