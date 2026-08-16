from adapters.gov_portal import GovPortalAdapter


class NbsAdapter(GovPortalAdapter):
    site_code = "bm36000002"
    search_page = "https://www.stats.gov.cn/search/s"
