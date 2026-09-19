package lab.pagination;

public final class PageEndpoint {
  private final PageWindow window=new PageWindow();
  public long firstRow(PageRequest r) { return window.offset(r.page,r.size); }
}
