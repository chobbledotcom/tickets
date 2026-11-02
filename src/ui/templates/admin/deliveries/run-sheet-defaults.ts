/**
 * The built-in run-sheet templates.
 *
 * The owner's saved template replaces these when it holds any text. Every
 * label comes from `labels`, so the wording follows the site's language while
 * the markup stays a template the owner can rewrite.
 */

export const DEFAULT_RUN_SHEET_HEADING = `{% if relative == "today" %}{{ labels.today }}{% elsif relative == "tomorrow" %}{{ labels.tomorrow }}{% else %}{{ date_label }}{% endif %}`;

export const DEFAULT_RUN_SHEET_BODY = `{% if day.bookings.size == 0 %}<p><em>{{ labels.nothing_scheduled }}</em></p>{% else %}<ul class="delivery-bookings">
{% for booking in day.bookings %}<li><ul>
<li><strong>{{ labels.name }}</strong> {{ booking.name }}</li>
<li><strong>{{ labels.listing }}</strong> {{ booking.listing }}</li>
{% if booking.address != "" %}<li><strong>{{ labels.address }}</strong> {{ booking.address }}{{ booking.maps_links }}</li>{% endif %}
{% if booking.phone != "" %}<li class="delivery-phone"><strong>{{ labels.phone }}</strong> {{ booking.phone_links }}</li>{% endif %}
{% if booking.token != "" %}<li><strong>{{ labels.token }}</strong> {{ booking.token }}</li>{% endif %}
<li><ul>
{% for leg in booking.legs %}<li class="delivery-leg{% if leg.done %} done{% endif %}"><span>{{ leg.label }}{% if leg.time != "" %} · {{ leg.time }}{% endif %} · {{ leg.agent }}</span>{{ leg.mark_form }}</li>
{% endfor %}</ul></li>
</ul></li>
{% endfor %}</ul>{% endif %}`;
