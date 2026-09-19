package lab.pagination;

public final class PageWindow {
  /** 页码从 1 开始，偏移必须保留 long 精度。 */
  public long offset(int page,int size) {
    if(page<1||size<1)throw new IllegalArgumentException("invalid page");
    return (page - 1) * size;
  }
}
