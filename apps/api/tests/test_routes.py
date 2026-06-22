from apps.api.app.main import app


def test_task_01_routes_are_registered():
    paths = {route.path for route in app.routes}

    assert "/listings" in paths
    assert "/listings/{listing_id}/upload" in paths
    assert "/listings/{listing_id}/jobs/last" in paths
